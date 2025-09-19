// gtfsWorker.js - PARSING + stop_times -> IndexedDB storage (one record per trip_id)
importScripts('libs/papaparse.min.js');
importScripts('libs/fflate.min.js');

// --- Utilities ---
function timeToSeconds(t) {
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.length !== 3) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
function postProgress(file, pct) {
  postMessage({ type: 'progress', file, progress: pct });
}

// --- parse helper for small CSVs (keeps behaviour for other files) ---
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

async function parseStopTimesStreamFromUint8Array(u8, tripsToFetchSet, onRow, onProgress) {
  const DECODER = new TextDecoder('utf-8');
  const CHUNK = 1 << 20; // 1 MiB chunks; tune if needed (2–4 MiB for a bit more speed)
  const totalBytes = u8.byteLength;
  let processedBytes = 0;

  // CSV state
  const delimiter = ',';
  const quote = '"';
  let inQuotes = false;
  let field = '';
  let row = [];
  let header = null;

  // For CRLF split across chunks
  let pendingSkipLF = false;
  // Strip BOM on first decoded string (if present)
  let firstChunk = true;

  // Column indexes (after header parsed)
  let idx_trip_id = -1, idx_stop_id = -1, idx_stop_seq = -1, idx_arr = -1, idx_dep = -1;

  const flushRow = () => {
    row.push(field);
    field = '';

    if (!header) {
      header = row;
      row = [];

      // Remove BOM if present in first header cell
      if (header.length && header[0] && header[0].charCodeAt(0) === 0xFEFF) {
        header[0] = header[0].slice(1);
      }
      idx_trip_id = header.indexOf('trip_id');
      idx_stop_id = header.indexOf('stop_id');
      idx_stop_seq = header.indexOf('stop_sequence');
      idx_arr     = header.indexOf('arrival_time');
      idx_dep     = header.indexOf('departure_time');
      return;
    }

    // Quickly read needed fields by index
    const get = (idx) => (idx >= 0 ? (row[idx] || '') : '');
    const tripId = get(idx_trip_id).trim();
    if (tripId && tripsToFetchSet.has(tripId)) {
      const stopId  = get(idx_stop_id).trim();
      const stopSeq = parseInt(get(idx_stop_seq), 10) || 0;
      const arrTime = get(idx_arr).trim();
      const depTime = get(idx_dep).trim();

      onRow(tripId, {
        trip_id:        tripId,
        stop_id:        stopId,
        stop_sequence:  stopSeq,
        arrival_time:   arrTime,
        departure_time: depTime
      });
    }
    row = [];
  };

  const processChunkString = (chunkStr) => {
    if (firstChunk) {
      firstChunk = false;
      // Strip BOM if whole-file BOM was decoded at start
      if (chunkStr.charCodeAt(0) === 0xFEFF) chunkStr = chunkStr.slice(1);
    }

    for (let i = 0; i < chunkStr.length; i++) {
      let c = chunkStr[i];

      // Handle CRLF across chunk boundaries
      if (pendingSkipLF) {
        pendingSkipLF = false;
        if (c === '\n') continue; // consume LF in CRLF
        // else proceed (lone CR)
      }

      if (c === quote) {
        if (inQuotes && i + 1 < chunkStr.length && chunkStr[i + 1] === quote) {
          field += quote; i++; // escaped quote ("")
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes) {
        if (c === delimiter) {
          row.push(field); field = '';
          continue;
        }
        if (c === '\r' || c === '\n') {
          flushRow();
          if (c === '\r') pendingSkipLF = true; // expect LF in CRLF
          continue;
        }
      }

      field += c;
    }
  };

  for (let offset = 0; offset < totalBytes; offset += CHUNK) {
    const end = Math.min(totalBytes, offset + CHUNK);
    const slice = u8.subarray(offset, end);
    const s = DECODER.decode(slice, { stream: end < totalBytes });
    processChunkString(s);

    processedBytes = end;
    if (onProgress) {
      onProgress(Math.min(0.999, processedBytes / totalBytes));
    }
  }

  // Finalize (if file didn't end with a newline)
  if (inQuotes) {
    // Malformed CSV (unterminated quote) — best-effort close
    inQuotes = false;
  }
  if (field.length > 0 || row.length > 0) {
    flushRow();
  }
}

let gtfsZipBuffer = null; // Store zipped GTFS file
// --- STOP_TIMES INDEX (NEW) ---
// Caches for stop_times index & header info, invalidated when a new rawZip arrives
let STOP_TIMES_TRIP_INDEX = null; // Map: trip_id -> { start: number, end: number }
let STOP_TIMES_HEADER_IDX = null; // { idx_trip_id, idx_stop_id, idx_stop_seq, idx_arr, idx_dep }
let STOP_TIMES_DATA_START = 0;    // byte offset of first data row (after header)
let STOP_TIMES_INDEX_WARNED_NONCONTIGUOUS = false;

function parseCsvHeaderLine(line) {
  // Header lines in GTFS are simple; still handle minimal quoted cells.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (!inQ && c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  // Trim BOM if present in first header cell
  if (out.length && out[0] && out[0].charCodeAt(0) === 0xFEFF) out[0] = out[0].slice(1);
  return out.map(s => s.trim());
}


/**
 * Build trip->byte range index in one pass, without fully decoding the file.
 * Assumes rows for a trip_id are contiguous (common in GTFS); if not, only the first
 * contiguous block per trip is indexed and we log a warning (once).
 */
function buildStopTimesTripIndex(u8) {
  const Q = 34, C = 44, CR = 13, LF = 10; // ", , \r, \n
  const dec = new TextDecoder('utf-8');

  let pos = 0;
  // Skip UTF-8 BOM if present
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) pos = 3;

  // ----- parse header (up to CR or LF) -----
  let headerEnd = pos;
  while (headerEnd < u8.length && u8[headerEnd] !== CR && u8[headerEnd] !== LF) headerEnd++;
  const headerLine = dec.decode(u8.subarray(pos, headerEnd));
  const header = parseCsvHeaderLine(headerLine);
  const idx_trip_id = header.indexOf('trip_id');
  const idx_stop_id = header.indexOf('stop_id');
  const idx_stop_seq = header.indexOf('stop_sequence');
  const idx_arr      = header.indexOf('arrival_time');
  const idx_dep      = header.indexOf('departure_time');
  if (idx_trip_id < 0) throw new Error('stop_times.txt missing trip_id column');
  STOP_TIMES_HEADER_IDX = { idx_trip_id, idx_stop_id, idx_stop_seq, idx_arr, idx_dep };

  // Move past line terminator(s)
  let next = headerEnd;
  if (next < u8.length && u8[next] === CR) next++;
  if (next < u8.length && u8[next] === LF) next++;
  STOP_TIMES_DATA_START = next;

  // ----- scan rows to find first byte of each trip and the next different trip -----
  const tripIndex = new Map();
  let rowStart = next;
  let fieldIndex = 0;
  let inQuotes = false;
  let i = next;

  // Only capture characters for the trip_id column to avoid allocations
  let tripBuf = [];
  let curTripId = null;
  let currentIndexedTrip = null;

  while (i <= u8.length) {
    const b = (i < u8.length) ? u8[i] : LF; // sentinel LF at end to flush last row

    if (b === Q) {
      if (inQuotes && i + 1 < u8.length && u8[i + 1] === Q) { // escaped quote
        if (fieldIndex === idx_trip_id) tripBuf.push('"'.charCodeAt(0));
        i += 2;
        continue;
      } else {
        inQuotes = !inQuotes;
        i++;
        continue;
      }
    }

    if (!inQuotes && (b === C || b === CR || b === LF)) {
      // Column delimiter or row end
      if (fieldIndex === idx_trip_id) {
        // finalize trip field (decode minimal)
        const tripId = dec.decode(new Uint8Array(tripBuf)).trim();
        curTripId = tripId;
      }

      if (b === C) {
        fieldIndex++;
      } else {
        // Row end -> commit index transitions
        if (curTripId && !tripIndex.has(curTripId)) {
          // first time we see this trip: record start
          tripIndex.set(curTripId, { start: rowStart, end: null });
          // If a previous trip block was open, close it now
          if (currentIndexedTrip && currentIndexedTrip !== curTripId) {
            const rec = tripIndex.get(currentIndexedTrip);
            if (rec && rec.end == null) rec.end = rowStart;
          }
          currentIndexedTrip = curTripId;
        } else if (curTripId && currentIndexedTrip && currentIndexedTrip !== curTripId) {
          // Non-contiguous trip detected (rare). We only index the FIRST block.
          if (!STOP_TIMES_INDEX_WARNED_NONCONTIGUOUS) {
            postMessage({ type: 'status', message: 'Warning: Non-contiguous trip_id blocks in stop_times.txt; index captures first block per trip.' });
            STOP_TIMES_INDEX_WARNED_NONCONTIGUOUS = true;
          }
          // Close previous block if still open and start new "current" (but do not override first index)
          const prev = tripIndex.get(currentIndexedTrip);
          if (prev && prev.end == null) prev.end = rowStart;
          currentIndexedTrip = curTripId; // continue tracking to keep blocks closed
        }

        // prepare for next row: advance i over CRLF
        let j = i + 1;
        if (b === CR && j < u8.length && u8[j] === LF) j++;
        rowStart = j;
        fieldIndex = 0;
        inQuotes = false;
        tripBuf = [];
        curTripId = null;
        i = j;
        continue;
      }

      // move past delimiter
      i++;
      continue;
    }

    // Regular byte
    if (fieldIndex === idx_trip_id) tripBuf.push(b);
    i++;
  }

  // Close final open block
  if (currentIndexedTrip) {
    const rec = tripIndex.get(currentIndexedTrip);
    if (rec && rec.end == null) rec.end = u8.length;
  }

  STOP_TIMES_TRIP_INDEX = tripIndex;
}

/**
 * Parse just a byte slice [start, end) of stop_times.txt (data rows only).
 * Uses precomputed column indexes from STOP_TIMES_HEADER_IDX.
 */
async function parseStopTimesSlice(u8, start, end, headerIdx, onRow) {
  const DECODER = new TextDecoder('utf-8');
  const CHUNK = 1 << 20; // 1 MiB
  // CSV state
  const delimiter = ',';
  const quote = '"';
  let inQuotes = false;
  let field = '';
  let row = [];

  const { idx_trip_id, idx_stop_id, idx_stop_seq, idx_arr, idx_dep } = headerIdx;

  const flushRow = () => {
    row.push(field); field = '';
    // Build object quickly using indexes
    const get = (idx) => (idx >= 0 ? (row[idx] ?? '') : '');
    const tripId = get(idx_trip_id).trim();
    const stopId = get(idx_stop_id).trim();
    const stopSeq = parseInt(get(idx_stop_seq), 10) || 0;
    const arrTime = get(idx_arr).trim();
    const depTime = get(idx_dep).trim();
    if (tripId) {
      onRow(tripId, {
        trip_id: tripId,
        stop_id: stopId,
        stop_sequence: stopSeq,
        arrival_time: arrTime,
        departure_time: depTime
      });
    }
    row = [];
  };

  const processChunkString = (chunkStr) => {
    for (let i = 0; i < chunkStr.length; i++) {
      const c = chunkStr[i];
      if (c === quote) {
        if (inQuotes && i + 1 < chunkStr.length && chunkStr[i + 1] === quote) {
          field += quote; i++; // escaped quote
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes) {
        if (c === delimiter) {
          row.push(field); field = '';
          continue;
        }
        if (c === '\r' || c === '\n') {
          flushRow();
          // consume LF after CR if present
          if (c === '\r' && i + 1 < chunkStr.length && chunkStr[i + 1] === '\n') {
            i++;
          }
          continue;
        }
      }
      field += c;
    }
  };

  // Stream-decode the slice
  for (let offset = start; offset < end; offset += CHUNK) {
    const sliceEnd = Math.min(end, offset + CHUNK);
    const s = DECODER.decode(u8.subarray(offset, sliceEnd), { stream: sliceEnd < end });
    processChunkString(s);
  }
  // Finalize (if last line doesn't end with newline)
  if (field.length > 0 || row.length > 0) flushRow();
}


// --- Unified onmessage handler ---
onmessage = async function (e) {
  try {
    // handle filtered-stop-times requests (reads from IndexedDB)
    if (e.data && e.data.type === 'extractStopTimesForTrips') {
            
      const tripIds   = e.data.tripIds || [];
      const requestId = e.data.requestId;

      // Edge cases
      if (!gtfsZipBuffer) {
        postMessage({ type: 'error', message: 'GTFS ZIP not loaded in worker. Load rawZip first.' });
        postMessage({ type: 'filteredStopTimes', stopTimes: [], requestId });
        return;
      }
      if (!tripIds.length) {
        postMessage({ type: 'filteredStopTimes', stopTimes: [], requestId });
        return;
      }

      // Unzip once; obtain stop_times.txt as Uint8Array
      let zipObj;
      try {
        zipObj = fflate.unzipSync(new Uint8Array(gtfsZipBuffer));
      } catch (err) {
        postMessage({ type: 'error', message: 'Failed to unzip GTFS: ' + (err?.message || String(err)) });
        postMessage({ type: 'filteredStopTimes', stopTimes: [], requestId });
        return;
      }

      const stBytes = zipObj['stop_times.txt'];
      if (!stBytes) {
        postMessage({ type: 'error', message: 'stop_times.txt missing from GTFS ZIP' });
        postMessage({ type: 'filteredStopTimes', stopTimes: [], requestId });
        return;
      }

      // Build the index once (first time only)
      if (!STOP_TIMES_TRIP_INDEX || !STOP_TIMES_HEADER_IDX) {
        postMessage({ type: 'status', message: 'Worker: indexing stop_times.txt (first pass)' });
        try {
          buildStopTimesTripIndex(stBytes);
        } catch (err) {
          // Index build failed: fallback to full scan for this request
          postMessage({ type: 'status', message: 'Worker: stop_times index failed; falling back to full scan for this request' });
          const tripsToFetchSet = new Set(tripIds);
          const stopTimesFallback = [];
          const onRow = (_tripId, rowObj) => stopTimesFallback.push(rowObj);
          const onProgress = (pct) => postMessage({ type: 'progress', file: 'filtered_stop_times', progress: pct });
          await parseStopTimesStreamFromUint8Array(stBytes, tripsToFetchSet, onRow, onProgress);
          postMessage({ type: 'progress', file: 'filtered_stop_times', progress: 1.0 });
          postMessage({ type: 'filteredStopTimes', stopTimes: stopTimesFallback, requestId });
          return;
        }
      }

      // Parse only the requested slices
      postMessage({ type: 'status', message: 'Worker: reading stop_times slices (indexed)' });
      const out = [];
      const onRow = (_tripId, rowObj) => out.push(rowObj);

      // Progress based on number of requested trips
      let doneTrips = 0;
      const totalTrips = tripIds.length;

      for (const tripId of tripIds) {
        const rec = STOP_TIMES_TRIP_INDEX.get(tripId);
        if (!rec) {
          // no rows for this trip_id in stop_times.txt
          doneTrips++;
          postMessage({ type: 'progress', file: 'filtered_stop_times', progress: Math.min(0.999, doneTrips / totalTrips) });
          continue;
        }
        await parseStopTimesSlice(stBytes, rec.start, rec.end, STOP_TIMES_HEADER_IDX, onRow);
        doneTrips++;
        postMessage({ type: 'progress', file: 'filtered_stop_times', progress: Math.min(0.999, doneTrips / totalTrips) });
      }
      // Parsing complete
      postMessage({ type: 'progress', file: 'filtered_stop_times', progress: 1.0 });
      postMessage({ type: 'filteredStopTimes', stopTimes:out, requestId });
      return;

    }
    // --- NEW: handle rawZip ---

    
    if (e.data && e.data.rawZip) {
      gtfsZipBuffer = e.data.rawZip; // store for later use

      // Invalidate stop_times index since the dataset changed
      STOP_TIMES_TRIP_INDEX = null;
      STOP_TIMES_HEADER_IDX = null;
      STOP_TIMES_DATA_START = 0;
      STOP_TIMES_INDEX_WARNED_NONCONTIGUOUS = false;

      // Unzip the raw ZIP buffer
      const zipFile = fflate.unzipSync(new Uint8Array(e.data.rawZip));

       // send file sizes early (main uses it to compute weights)
      (function sendFileSizesIfPossible(zf) {
        try {
          const files = {};
          if (zf && typeof zf === 'object') {
            for (const k in zf) {
              const v = zf[k];
              files[k] = (v && (v.byteLength || (v.length ? v.length : 0))) || 0;
            }
          }
          postMessage({ type: 'files', files });
        } catch (err) { /* ignore */ }
      })(zipFile);

      if (!zipFile) {
        postMessage({ type: 'error', message: 'Worker: no zipFile provided. Please call worker with zipFile mapping files->Uint8Array.' });
        return;
      }

      postMessage({ type: 'status', message: 'Worker: starting parsing' });

      // prepare results
      const results = {
        stops: null, routes: null, trips: null, 
        calendar: null, calendar_dates: null,
        stopsById: null, shapesById: null, shapeIdToDistance: null,
        stop_times_trip_index: null
      };

      // --- stops ---
      if (zipFile['stops.txt']) {
        postMessage({ type: 'status', message: 'Worker: parsing stops.txt (Blob)' });
        let stops = await parseBlobToObjects(zipFile['stops.txt'], 'stops.txt');
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

        stops = null; // free memory
      }


      // --- routes ---
      if (zipFile['routes.txt']) {
        postMessage({ type: 'status', message: 'Worker: parsing routes.txt (Blob)' });
        let routes = await parseBlobToObjects(zipFile['routes.txt'], 'routes.txt');
        results.routes = routes;

        routes = null; // free memory
      }

      // --- trips ---
      if (zipFile['trips.txt']) {
        postMessage({ type: 'status', message: 'Worker: parsing trips.txt (Blob)' });
        let trips = await parseBlobToObjects(zipFile['trips.txt'], 'trips.txt');
        results.trips = trips;

        trips = null; // free memory
      }

      // --- shapes ---
      if (zipFile['shapes.txt']) {
        postMessage({ type: 'status', message: 'Worker: parsing shapes.txt (Blob)' });
        let shapes = await parseBlobToObjects(zipFile['shapes.txt'], 'shapes.txt');
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
            const aa = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon/2)**2;
            const d = R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
            cum += d;
          }
          shapeIdToDistance[id] = cum;
        });
        results.shapesById = shapesById;
        results.shapeIdToDistance = shapeIdToDistance;

        shapes = null; // free memory      
      }

      // --- stop_times: stream-parse and write per-trip to IndexedDB (also build small indices) ---

      //      if (zipFile['stop_times.txt']) {
      // do not read stop_times during initial read
        

      // --- calendar & calendar_dates ---
      if (zipFile['calendar.txt']) {
        postMessage({ type: 'status', message: 'Worker: parsing calendar.txt (Blob)' });
        const calRows = await parseBlobToObjects(zipFile['calendar.txt'], 'calendar.txt');
        const cal = [];
        for (const obj of calRows) {
          cal.push({
            service_id: obj.service_id,
            days: {
              monday: +obj.monday, tuesday: +obj.tuesday, wednesday: +obj.wednesday,
              thursday: +obj.thursday, friday: +obj.friday, saturday: +obj.saturday, sunday: +obj.sunday
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
    }
  } catch (err) {
    postMessage({ type: 'error', message: err.message || String(err) });
  }
};
