importScripts('libs/papaparse.min.js');
// gtfsWorker.js - Blob-based parsing (only #1 fix: parse from Blob instead of decoding whole string)

// Helper (kept in case other code paths use it)
function decodeBytes(arr) {
  const decoder = new TextDecoder('utf-8');
  if (arr instanceof ArrayBuffer) return decoder.decode(new Uint8Array(arr));
  return decoder.decode(arr);
}
function timeToSeconds(t) {
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.length !== 3) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
function postProgress(file, pct) {
  postMessage({ type: 'progress', file, progress: pct });
}

// --- NEW: helper to parse a Blob/Uint8Array into objects (header:true) without creating a huge string
function parseBlobToObjects(bytesOrBuffer, fileLabel) {
  return new Promise((resolve, reject) => {
    try {
      const blob = new Blob([bytesOrBuffer]);
      Papa.parse(blob, {
        header: true,
        skipEmptyLines: true,
        complete: function(results) {
          postProgress(fileLabel, 1);
          resolve(results.data);
        },
        error: function(err) {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
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
      postMessage({ type: 'status', message: 'Worker: parsing stops.txt (Blob)' });
      const stops = await parseBlobToObjects(zipFile['stops.txt'], 'stops.txt');
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
      postMessage({ type: 'status', message: 'Worker: parsing routes.txt (Blob)' });
      const routes = await parseBlobToObjects(zipFile['routes.txt'], 'routes.txt');
      results.routes = routes;
    }

    // --- trips ---
    if (zipFile['trips.txt']) {
      postMessage({ type: 'status', message: 'Worker: parsing trips.txt (Blob)' });
      const trips = await parseBlobToObjects(zipFile['trips.txt'], 'trips.txt');
      results.trips = trips;
    }

    // --- shapes (group and compute distance) ---
    if (zipFile['shapes.txt']) {
      postMessage({ type: 'status', message: 'Worker: parsing shapes.txt (Blob)' });
      const shapes = await parseBlobToObjects(zipFile['shapes.txt'], 'shapes.txt');
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
        let cum = 0;
        for (let k = 1; k < arr.length; k++) {
          const a = arr[k-1], b = arr[k];
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
          files[k] = (v && (v.byteLength || (v.length ? v.length : 0))) || 0;
        }
        postMessage({ type: 'files', files });
      } catch (e) {
        // non-fatal
      }
    })(zipFile);

    // --- stop_times (streamed from Blob; no giant decoded string for parsing) ---
    // --- stop_times: awaitable streaming parse (keeps results.stop_times_text) ---
    if (zipFile['stop_times.txt']) {
      postMessage({ type: 'status', message: 'Worker: indexing stop_times.txt (Blob, streaming)' });

      const stBlob = new Blob([zipFile['stop_times.txt']]);

      // wrap in a promise so we await completion
      await new Promise((resolve, reject) => {
        let lineNum = 0;
        let lastTripId = null;
        const tripLineIndex = {};
        const tripStartTimeMap = {};
        const tripStopsMap = {};

        // defensive quick-check
        postMessage({ type: 'status', message: `Worker: stop_times blob size ${stBlob.size}` });

        Papa.parse(stBlob, {
          header: true,
          skipEmptyLines: true,
          step: function(results) {
            lineNum++;
            const row = results.data;
            const tripId = row.trip_id ? row.trip_id.trim() : '';
            const stopId = row.stop_id ? row.stop_id.trim() : '';
            const stopSeq = row.stop_sequence ? parseInt(row.stop_sequence, 10) : 0;
            const depTimeStr = row.departure_time ? row.departure_time.trim() : '';
            const depTimeSec = depTimeStr ? timeToSeconds(depTimeStr) : null;

            // Build tripLineIndex
            if (tripId !== lastTripId) {
              if (lastTripId !== null) {
                tripLineIndex[lastTripId].end = lineNum - 1;
              }
              tripLineIndex[tripId] = { start: lineNum, end: lineNum };
              lastTripId = tripId;
            } else {
              tripLineIndex[tripId].end = lineNum;
            }

            // Build tripStopsMap
            if (!tripStopsMap[tripId]) tripStopsMap[tripId] = [];
            if (stopId) tripStopsMap[tripId].push({ stop_id: stopId, stop_sequence: stopSeq });

            // Build tripStartTimeMap
            if (depTimeSec != null && (!tripStartTimeMap[tripId] || stopSeq === 1 || depTimeSec < tripStartTimeMap[tripId])) {
              tripStartTimeMap[tripId] = depTimeSec;
            }

            // optional: emit progress occasionally
            if (lineNum % 100000 === 0) postMessage({ type: 'status', message: `Worker: processed ${lineNum} stop_time lines` });
          },
          complete: function() {
            if (lastTripId !== null) {
              tripLineIndex[lastTripId].end = lineNum;
            }
            const tripStopsMapObj = {};
            Object.keys(tripStopsMap).forEach(tripId => {
              tripStopsMap[tripId].sort((a, b) => a.stop_sequence - b.stop_sequence);
              tripStopsMapObj[tripId] = tripStopsMap[tripId].map(obj => obj.stop_id);
            });

            // Re-create full decoded text for testing (note: this reintroduces large string)
            stBlob.text().then(text => {
              results.stop_times_text = text; // kept for incremental testing
              results.stop_times_trip_index = tripLineIndex;
              results.tripStartTimeMap = tripStartTimeMap;
              results.tripStopsMap = tripStopsMapObj;

              postMessage({ type: 'status', message: 'Worker: finished parsing stop_times.txt' });
              resolve();
            }).catch(err => {
              // fallback: no text
              results.stop_times_text = null;
              results.stop_times_trip_index = tripLineIndex;
              results.tripStartTimeMap = tripStartTimeMap;
              results.tripStopsMap = tripStopsMapObj;

              postMessage({ type: 'status', message: 'Worker: finished parsing stop_times.txt (text unavailable)' });
              resolve();
            });
          },
          error: function(err) {
            postMessage({ type: 'error', message: 'Papa parse error for stop_times: ' + (err && err.message) });
            reject(err);
          }
        });
      }); // await the promise
    }

    // --- calendar & calendar_dates (optional) ---
    if (zipFile['calendar.txt']) {
      postMessage({ type: 'status', message: 'Worker: parsing calendar.txt (Blob)' });
      const calRows = await parseBlobToObjects(zipFile['calendar.txt'], 'calendar.txt');
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
      postMessage({ type: 'status', message: 'Worker: parsing calendar_dates.txt (Blob)' });
      const cdRows = await parseBlobToObjects(zipFile['calendar_dates.txt'], 'calendar_dates.txt');
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
