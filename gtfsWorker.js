importScripts('libs/papaparse.min.js');
// gtfsWorker.js
// Worker that receives an object mapping filenames -> Uint8Array (uncompressed file bytes).
// It parses GTFS files and posts progress/status messages back to the main thread.

// Helper: decode ArrayBuffer/Uint8Array to string
function decodeBytes(arr) {
  const decoder = new TextDecoder('utf-8');
  // if it's already ArrayBuffer
  if (arr instanceof ArrayBuffer) return decoder.decode(new Uint8Array(arr));
  // if it's Uint8Array
  return decoder.decode(arr);
}
function timeToSeconds(t) {
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.length !== 3) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Post helper
function postProgress(file, pct) {
  postMessage({ type: 'progress', file, progress: pct });
}

// Utility to parse generic CSV into array of rows (objects keyed by header)
function parseCSVToObjects(text, fileLabel) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  const rows = parsed.data;
  postProgress(fileLabel, 1);
  return rows;
}

onmessage = async function (e) {
  try {
    const { zipFile } = e.data;
    postMessage({ type: 'status', message: 'Worker: starting parsing' });

    // Results object to send back
    const results = {
      stops: null,
      routes: null,
      trips: null,
      shapes: null,
      stop_times: null,
      calendar: null,
      calendar_dates: null,
      // indexes
      stopsById: null,
      shapesById: null,
      shapeIdToDistance: null,      
      tripStopsMap: null
    };

    // --- stops ---
    if (zipFile['stops.txt']) {
      postMessage({ type: 'status', message: 'Worker: decoding stops.txt' });
      const stopsText = decodeBytes(zipFile['stops.txt']);
      const stops = parseCSVToObjects(stopsText, 'stops.txt');
      const stopsById = {};
      for (const obj of stops) {
        const id = obj.stop_id ? obj.stop_id.trim() : '';
        obj.id = id;
        obj.name = obj.stop_name ? obj.stop_name.trim() : '';
        obj.lat = parseFloat(obj.stop_lat);
        obj.lon = parseFloat(obj.stop_lon);
        if (id) stopsById[id] = obj;
      }
      results.stops = stops;
      results.stopsById = stopsById;
    }

    // --- routes ---
    if (zipFile['routes.txt']) {
      postMessage({ type: 'status', message: 'Worker: decoding routes.txt' });
      const routesText = decodeBytes(zipFile['routes.txt']);
      const routes = parseCSVToObjects(routesText, 'routes.txt');
      results.routes = routes;
    }

    // --- trips ---
    if (zipFile['trips.txt']) {
      postMessage({ type: 'status', message: 'Worker: decoding trips.txt' });
      const tripsText = decodeBytes(zipFile['trips.txt']);
      const trips = parseCSVToObjects(tripsText, 'trips.txt');
      results.trips = trips;
    }

    // --- shapes (group and compute distance) ---
    if (zipFile['shapes.txt']) {
      postMessage({ type: 'status', message: 'Worker: decoding shapes.txt' });
      const shapesText = decodeBytes(zipFile['shapes.txt']);
      const shapes = parseCSVToObjects(shapesText, 'shapes.txt');
      const shapesById = {};
      for (const obj of shapes) {
        const sid = obj.shape_id ? obj.shape_id.trim() : '';
        obj.lat = parseFloat(obj.shape_pt_lat);
        obj.lon = parseFloat(obj.shape_pt_lon);
        obj.sequence = parseInt(obj.shape_pt_sequence, 10);
        obj.shape_dist_traveled = obj.shape_dist_traveled !== undefined ? parseFloat(obj.shape_dist_traveled) : undefined;
        if (!shapesById[sid]) shapesById[sid] = [];
        shapesById[sid].push(obj);
      }
      // sort and compute cumulative distances
      const shapeIdToDistance = {};
      Object.keys(shapesById).forEach(id => {
        const arr = shapesById[id];
        arr.sort((a, b) => a.sequence - b.sequence);
        // compute cumulative distances
        let cum = 0;
        for (let k = 1; k < arr.length; k++) {
          const a = arr[k-1], b = arr[k];
          // haversine (approx)
          const R = 6371000;
          const toRad = deg => deg * Math.PI / 180;
          const dLat = toRad(b.lat - a.lat);
          const dLon = toRad(b.lon - a.lon);
          const aa = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
          const d = R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
          cum += d;
        }
        shapeIdToDistance[id] = cum;
      });
      results.shapes = shapes;
      results.shapesById = shapesById;
      results.shapeIdToDistance = shapeIdToDistance;
    }

        // --- BEFORE any parsing (near top of onmessage): send file sizes for progress weighting ---
    (function sendFileSizesIfPossible(zipFile) {
      try {
        const files = {};
        for (const k in zipFile) {
          const v = zipFile[k];
          // v may be Uint8Array or ArrayBuffer; compute byteLength
          files[k] = (v && (v.byteLength || (v.length ? v.length : 0))) || 0;
        }
        postMessage({ type: 'files', files });
      } catch (e) {
        // non-fatal
      }
    })(zipFile);


    // --- stop_times (streamed, no giant array) ---
    if (zipFile['stop_times.txt']) {
      postMessage({ type: 'status', message: 'Worker: indexing stop_times.txt' });

      const stText = decodeBytes(zipFile['stop_times.txt']);
      const lines = stText.split(/\r?\n/);
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
      const idx = {
        trip_id: headers.indexOf('trip_id'),
        stop_id: headers.indexOf('stop_id'),
        stop_sequence: headers.indexOf('stop_sequence'),
        arrival_time: headers.indexOf('arrival_time'),
        departure_time: headers.indexOf('departure_time')
      };

      // Build index: trip_id -> {start: lineNum, end: lineNum}
      const tripLineIndex = {};
      const tripStartTimeMap = {};
      const tripStopsMap = {};

      let lastTripId = null;
      for (let i = 1; i < lines.length; i++) {
        const row = lines[i];
        if (!row) continue;
        const cols = row.split(',');
        const tripId = cols[idx.trip_id] ? cols[idx.trip_id].trim() : '';
        const stopId = cols[idx.stop_id] ? cols[idx.stop_id].trim() : '';
        const stopSeq = parseInt(cols[idx.stop_sequence], 10) || 0;
        const depTimeStr = cols[idx.departure_time] ? cols[idx.departure_time].trim() : '';
        const depTimeSec = timeToSeconds(depTimeStr);

        // --- Build tripLineIndex as before ---
        if (tripId !== lastTripId) {
          if (lastTripId !== null) {
            tripLineIndex[lastTripId].end = i - 1;
          }
          tripLineIndex[tripId] = { start: i, end: i };
          lastTripId = tripId;
        } else {
          tripLineIndex[tripId].end = i;
        }

        // --- Build tripStopsMap: collect stop_id and stop_sequence for each trip ---
        if (!tripStopsMap[tripId]) tripStopsMap[tripId] = [];
        if (stopId) tripStopsMap[tripId].push({ stop_id: stopId, stop_sequence: stopSeq });
        
        // --- Build tripStartTimeMap: store the earliest departure_time for each trip ---
        if (depTimeSec != null && (!tripStartTimeMap[tripId] || stopSeq === 1 || depTimeSec < tripStartTimeMap[tripId])) {
          tripStartTimeMap[tripId] = depTimeSec;
        }
      }
      // Set end for last trip
      if (lastTripId !== null) {
        tripLineIndex[lastTripId].end = lines.length - 1;
      }

      // Convert tripStopsMap to arrays of stop_ids in order
      const tripStopsMapObj = {};
      Object.keys(tripStopsMap).forEach(tripId => {
        tripStopsMap[tripId].sort((a, b) => a.stop_sequence - b.stop_sequence);
        tripStopsMapObj[tripId] = tripStopsMap[tripId].map(obj => obj.stop_id);
      });

      results.stop_times_text = stText; // Save the raw text for later slicing
      results.stop_times_trip_index = tripLineIndex;
      results.tripStartTimeMap = tripStartTimeMap;
      results.tripStopsMap = tripStopsMapObj;

      console.log('Built stop_times trip index for', Object.keys(tripLineIndex).length, 'trips');
    }
    
    // --- calendar & calendar_dates (optional) ---
    if (zipFile['calendar.txt']) {
      postMessage({ type: 'status', message: 'Worker: decoding calendar.txt' });
      const calText = decodeBytes(zipFile['calendar.txt']);
      const calRows = parseCSVToObjects(calText, 'calendar.txt');
      const cal = [];
      for (const obj of calRows) {
        cal.push({
          service_id: obj.service_id,
          days: {
            monday: +obj.monday,
            tuesday: +obj.tuesday,
            wednesday: +obj.wednesday,
            thursday: +obj.thursday,
            friday: +obj.friday,
            saturday: +obj.saturday,
            sunday: +obj.sunday
          },
          start_date: obj.start_date,
          end_date: obj.end_date
        });
      }
      results.calendar = cal;
    }

    if (zipFile['calendar_dates.txt']) {
      postMessage({ type: 'status', message: 'Worker: decoding calendar_dates.txt' });
      const cdText = decodeBytes(zipFile['calendar_dates.txt']);
      const cdRows = parseCSVToObjects(cdText, 'calendar_dates.txt');
      const cds = [];
      for (const obj of cdRows) {
        cds.push({
          service_id: obj.service_id,
          date: obj.date,
          exception_type: +obj.exception_type
        });
      }
      results.calendar_dates = cds;
    }

    postMessage({ type: 'status', message: 'Worker: parsing complete' });
    postMessage({ type: 'done', results });
  } catch (err) {
    postMessage({ type: 'error', message: err.message || String(err) });
  }
};
