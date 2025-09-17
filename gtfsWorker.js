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

// --- IndexedDB helpers ---
let _gtfsDB = null;
function openGTFSDB(dbName = 'gtfs_db', version = 1) {
  return new Promise((resolve, reject) => {
    if (_gtfsDB) return resolve(_gtfsDB);
    const req = indexedDB.open(dbName, version);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('stop_times_by_trip')) db.createObjectStore('stop_times_by_trip', { keyPath: 'trip_id' });
      if (!db.objectStoreNames.contains('trip_index')) db.createObjectStore('trip_index', { keyPath: 'trip_id' });
    };
    req.onsuccess = () => {
      _gtfsDB = req.result;
      resolve(_gtfsDB);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB open error'));
  });
}

function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readwrite');
    const st = tx.objectStore(storeName);
    const r = st.put(value);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IDB put error'));
  });
}

function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const st = tx.objectStore(storeName);
    const r = st.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IDB get error'));
  });
}

// --- Write queue for per-trip writes to avoid many tiny transactions ---
// ---- Batched trip-write queue (faster than many small transactions) ----

// tuning knobs - adjust to taste
const TRIP_BATCH_SIZE = 5000;        // how many trip records to group per transaction
const TRIP_WRITE_CONCURRENCY = 1;   // how many batch transactions may run concurrently

// internal batch buffers
let _tripBatch = [];                // accumulating items until we reach batch size
let _tripBatchesPending = [];       // batches ready to be written (each batch is array of items)
let _tripWritesInProgress = 0;      // number of batch transactions currently running

// queue a single trip write (called by parser)
function queueTripWrite(db, tripId, arr) {
  // sort here to keep final write simple
  arr.sort((a,b) => (a.stop_sequence || 0) - (b.stop_sequence || 0));
  _tripBatch.push({ db, tripId, arr });

  // if batch reached size, move to pending list for processing
  if (_tripBatch.length >= TRIP_BATCH_SIZE) {
    const batch = _tripBatch.splice(0, TRIP_BATCH_SIZE);
    _tripBatchesPending.push(batch);
    setTimeout(processPendingBatches, 0);
  }
}

// flush any leftover items into pending batches (call this once parsing is complete)
function flushTripBatch() {
  if (_tripBatch.length === 0) return;
  const batch = _tripBatch.splice(0, _tripBatch.length);
  _tripBatchesPending.push(batch);
  setTimeout(processPendingBatches, 0);
}

// process pending batches with concurrency limit
function processPendingBatches() {
  if (_tripWritesInProgress >= TRIP_WRITE_CONCURRENCY) return;
  const batch = _tripBatchesPending.shift();
  if (!batch) return;

  _tripWritesInProgress++;

  // pick db from first item (all items in batch will have same DB in usage)
  const db = batch[0].db;
  const tx = db.transaction(['stop_times_by_trip', 'trip_index'], 'readwrite');
  const st = tx.objectStore('stop_times_by_trip');
  const idx = tx.objectStore('trip_index');

  try {
    for (const item of batch) {
      st.put({ trip_id: item.tripId, stop_times: item.arr });
      const first = item.arr.find(r => r.stop_sequence === 1) || item.arr[0] || {};
      const startAcc = first ? (first.departure_time || first.arrival_time || null) : null;
      idx.put({ trip_id: item.tripId, start_time: startAcc, stop_count: item.arr.length });
    }
  } catch (err) {
    // continue; tx.onerror will still run if DB-level problem occurs
    console.warn('Batch write loop error', err);
  }

  tx.oncomplete = () => {
    _tripWritesInProgress--;
    setTimeout(processPendingBatches, 0);
  };
  tx.onerror = () => {
    _tripWritesInProgress--;
    setTimeout(processPendingBatches, 0);
  };
}

// Wait until all pending batches and in-flight transactions are done.
// Call flushTripBatch() first to ensure remaining partial batch is queued.
function waitForQueuedWrites() {
  return new Promise((resolve) => {
    const check = () => {
      if (_tripBatch.length === 0 && _tripBatchesPending.length === 0 && _tripWritesInProgress === 0) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// --- Helper to fetch many trips from IDB with limited concurrency ---
async function getStopTimesForTripsFromIDB(db, tripIds) {
  const results = {};
  const concurrency = 8;
  let i = 0;
  async function workerLoop() {
    while (true) {
      const idx = i++;
      if (idx >= tripIds.length) break;
      const tid = tripIds[idx];
      try {
        const rec = await idbGet(db, 'stop_times_by_trip', tid);
        // Add trip_id back to each stop_time object
        results[tid] = rec && rec.stop_times
          ? rec.stop_times.map(st => ({ ...st, trip_id: tid }))
          : [];
      } catch (err) {
        results[tid] = []; // on error return empty
      }
    }
  }
  const workers = new Array(Math.min(concurrency, tripIds.length)).fill(0).map(() => workerLoop());
  await Promise.all(workers);
  // produce flattened array in same trip order (if desired)
  const flattened = [];
  for (const t of tripIds) {
    if (results[t] && results[t].length) {
      flattened.push(...results[t]);
    }
  }
  return flattened;
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




// --- Unified onmessage handler ---
onmessage = async function (e) {
  try {
    // handle filtered-stop-times requests (reads from IndexedDB)
    if (e.data && e.data.type === 'extractStopTimesForTrips') {
      const requestId = e.data.requestId;
      const tripIds = e.data.tripIds || [];
      const total = tripIds.length;
      let completed = 0;
      const db = await openGTFSDB();
      const stopTimes = [];

      for (const tid of tripIds) {
        const rec = await idbGet(db, 'stop_times_by_trip', tid);
        if (rec && rec.stop_times) stopTimes.push(...rec.stop_times.map(st => ({ ...st, trip_id: tid })));
        completed++;
        // Report progress every 100 trips or at the end
        if (completed % 100 === 0 || completed === total) {
          postMessage({
            type: 'progress',
            file: 'filtered_stop_times',
            progress: completed / total
          });
        }
      }

      postMessage({ type: 'filteredStopTimes', stopTimes, requestId });
      return;
    }

    // --- NEW: handle rawZip ---
    let zipFileCandidate = null;
    if (e.data && e.data.rawZip) {
      // Unzip the raw ZIP buffer
      zipFileCandidate = fflate.unzipSync(new Uint8Array(e.data.rawZip));
    } else if (e.data && e.data.zipFile) {
      zipFileCandidate = e.data.zipFile;
    }
    const zipFile = (zipFileCandidate && typeof zipFileCandidate === 'object' && (zipFileCandidate['stops.txt'] || zipFileCandidate['routes.txt'])) 
                    ? zipFileCandidate 
                    : null;

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
    })(zipFileCandidate);

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
      stop_times_trip_index: null, tripStartTimeMap: null, tripFirstStopsMap: null
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

    if (zipFile['stop_times.txt']) {
      postMessage({ type: 'status', message: 'Worker: ingesting stop_times.txt to IndexedDB (streaming)' });

      const db = await openGTFSDB();
      const stBlob = new Blob([zipFile['stop_times.txt']]);

      // State for small indices (kept in-memory)
      let lineNum = 0;
      let lastTripId = null;
      const tripLineIndex = {};
      const tripStartTimeMap = {};
      let tripStops = {}; // temporary object to collect stop_ids (will be reduced to arrays)

      // For per-trip accumulation while reading sequentially
      let currTrip = null;
      let currBuffer = [];

      const totalBytes = zipFile['stop_times.txt'].byteLength;
      let bytesRead = 0;
      let avgBytesPerLine = null;
      let sampleLineBytes = 0;
      let sampleLineCount = 0;

      await new Promise((resolve, reject) => {
        Papa.parse(stBlob, {
          header: true,
          skipEmptyLines: true,
          step: function(resultsStep) {
            lineNum++;

             // Estimate bytes per line using the first 100 lines
            if (sampleLineCount < 100) {
              // Estimate using the length of the CSV row string
              sampleLineBytes += resultsStep.data.arrival_time.length +
                                resultsStep.data.departure_time.length +
                                resultsStep.data.stop_id.length +
                                resultsStep.data.stop_sequence.toString().length +
                                resultsStep.data.trip_id.length;
              sampleLineCount++;
              if (sampleLineCount === 100) {
                avgBytesPerLine = sampleLineBytes / 100;
              }
            }
            // After 100 lines, use the estimate
            if (avgBytesPerLine && lineNum % 10000 === 0) {
              const estimatedTotalLines = Math.round(totalBytes / avgBytesPerLine);
              const pct = 10 + Math.round(80 * (lineNum / estimatedTotalLines));
              postMessage({ type: 'progress', file: 'stop_times.txt', progress: pct / 100 });
            }

            const row = resultsStep.data;
            const tripId = row.trip_id ? row.trip_id.trim() : '';
            const stopId = row.stop_id ? row.stop_id.trim() : '';
            const stopSeq = row.stop_sequence ? parseInt(row.stop_sequence, 10) : 0;
            const depTimeStr = row.departure_time ? row.departure_time.trim() : '';
            
            // build small in-memory index (tripLineIndex)
            if (tripId !== lastTripId) {
              if (lastTripId !== null) {
                tripLineIndex[lastTripId].end = lineNum - 1;
              }
              tripLineIndex[tripId] = { start: lineNum, end: lineNum };
              lastTripId = tripId;
            } else {
              tripLineIndex[tripId].end = lineNum;
            }
            
            // tripStops map
            if (!tripStops[tripId]) tripStops[tripId] = [];
            if (stopId) tripStops[tripId].push({ stop_id: stopId, stop_sequence: stopSeq });
            
            // tripStartTimeMap
            if(stopSeq ===1){
              const depTimeSec = depTimeStr ? timeToSeconds(depTimeStr) : null;
              if (depTimeSec != null && (!tripStartTimeMap[tripId] || depTimeSec < tripStartTimeMap[tripId])) {
                tripStartTimeMap[tripId] = depTimeSec;
              }
            }

            // accumulation for IDB storing by trip
            if (!currTrip) {
              currTrip = tripId;
              currBuffer = [];
            }
            if (tripId !== currTrip) {
              // flush current buffer to IDB
              queueTripWrite(db, currTrip, currBuffer.splice(0, currBuffer.length));
              currTrip = tripId;
              currBuffer = [];
            }
            // add current row to buffer (small object)
            currBuffer.push({              
              arrival_time: row.arrival_time ? row.arrival_time.trim() : '',
              departure_time: row.departure_time ? row.departure_time.trim() : '',
              stop_id: stopId,
              stop_sequence: stopSeq
            });

            if (lineNum % 100000 === 0) postMessage({ type: 'status', message: `Worker: processed ${lineNum} stop_time lines` });
          },
          complete: function() {
            if (currTrip && currBuffer.length) {
              queueTripWrite(db, currTrip, currBuffer.splice(0, currBuffer.length));
            }

            // convert tripStops to arrays of stop_ids sorted by stop_sequence
            const tripStopsMapObj = {};
            Object.keys(tripStops).forEach(tripId => {
              // Sort stops by stop_sequence
              tripStops[tripId].sort((a,b) => a.stop_sequence - b.stop_sequence);
              // Store only the first stop_id
              tripStopsMapObj[tripId] = tripStops[tripId][0]?.stop_id || null;
            });

            // set results indices
            results.tripStartTimeMap = tripStartTimeMap;
            results.tripFirstStopsMap = tripStopsMapObj;

            tripStops = null; // free memory

            postMessage({ type: 'status', message: 'Worker: finished ingesting stop_times to IndexedDB' });
            postMessage({ type: 'progress', file: 'stop_times.txt', progress: 0.9 });
            // wait for queued writes to finish
            flushTripBatch();
            waitForQueuedWrites().then(resolve).catch(reject);
          },
          error: function(err) {
            postMessage({ type: 'error', message: 'Papa parse error for stop_times: ' + (err && err.message) });
            reject(err);
          }
        });
      });
    }

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
  } catch (err) {
    postMessage({ type: 'error', message: err.message || String(err) });
  }
};
