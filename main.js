// Updated JavaScript: GTFS Animation with Accurate Interpolation Based on Stop Times

// === Global GTFS data ===
let stops = [];
let shapes = [];
let routes = [];
let trips = [];
let stopTimes = [];

let animationTimer = null;
let animationTime = null;
let animationStartTime = null;
let currentTrip = null;
let remainingTrips = [];

// === Layers for filtering geometry ===
let stopsLayer = null;
let shapesLayer = null;

// === Filter & Animation State ===
let routeTypes = [];
let serviceIds = [];
let filteredTrips = [];
let tripPaths = [];
let allVehicleMarkers = [];
let vehicleMarkersWithActiveTrip = null;

// === Calendar/Service-Date Data ===
let calendar = [];
let calendarDates = [];
let serviceDateDict = {}; // { 'YYYYMMDD': Set(service_id) }
let genericWeekdayDates = {}; // { 'Monday (Generic)': [date1, date2, ...], ... }
let serviceDateFilterMode = false; // true if using service-date filter

// === Precomputed maps ===
let tripStartTimeMap = {};   // 
let tripStopsMap     = {};   // 
let blockIdTripMap = {};

// === Short‑name lookup by route_type ===
let shortAndLongNamesByType = {}; // 
let shortNameToServiceIds = {}; 

// === Animation Controls ===
const FRAME_INTERVAL_MS = 100;   // real ms per frame
const TIME_STEP_SEC    = 1;    // simulated seconds per frame
let speedMultiplier = 10;

let stopsById = new Map();           // stop_id -> {id,name,lat,lon}
let shapesById = {};                 // shape_id -> [ {lat,lon,sequence,shape_dist_traveled}, ... ]
let shapeCumulativeDist = {};        // shape_id -> [cumulative distances]
let stopTimesByTripId = {};          // trip_id -> [ {trip_id,stop_id,arrival_time,departure_time,stop_sequence,departure_sec}, ... ]

let lastDraggedDepth = 0; // for handling drag events on markers

const ROUTE_TYPE_NAMES = {
  0: "Tram, Streetcar, Light rail",
  1: "Subway, Metro",
  2: "Rail",
  3: "Bus",
  4: "Ferry",
  5: "Cable tram",
  6: "Aerial lift",
  7: "Funicular",
  11: "Trolleybus",
  12: "Monorail"
};

// === Initialize Leaflet Map ===
const map = L.map('map').setView([0, 0], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

let vehKmPendingPoints = {}; // { route_id: [{ x, y }], ... }

async function loadGtfsFromWebZip() {
  const url = 'gtfs.zip';
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const zip = fflate.unzipSync(new Uint8Array(buffer));
    LoadGTFSZipFile(zip);
  } catch (err) {
    console.error('Failed to load GTFS ZIP:', err);
  }
}


// Function to load GTFS from a user-uploaded zip file
async function loadGtfsFromUserUploadZip(file) {

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const buffer = e.target.result;
      const zip = fflate.unzipSync(new Uint8Array(buffer));

      LoadGTFSZipFile(zip);     
    } catch (err) {     
      alert('Failed to load GTFS ZIP: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}


async function LoadGTFSZipFile(zipFileInput) {
  try {
    showProgressBar();
    setProgressBar(5);

    clearAllMapLayersAndMarkers();

    // We support three types of input:
    // 1) File object (from input) -> read as ArrayBuffer (preferred)
    // 2) ArrayBuffer or Uint8Array (raw zip bytes) -> preferred
    // 3) Existing unzipped object { 'stops.txt': Uint8Array, ... } -> fallback (less efficient)
    let rawZipBuffer = null;
    let fallbackZipObj = null;

    // detect type:
    if (zipFileInput instanceof File) {
      // read raw bytes
      rawZipBuffer = await zipFileInput.arrayBuffer();
    } else if (zipFileInput instanceof ArrayBuffer) {
      rawZipBuffer = zipFileInput;
    } else if (zipFileInput instanceof Uint8Array) {
      rawZipBuffer = zipFileInput.buffer;
    } else if (zipFileInput && typeof zipFileInput === 'object' && (zipFileInput['stops.txt'] || zipFileInput['routes.txt'])) {
      // fallback: the user passed an already-unzipped object mapping names -> Uint8Array
      fallbackZipObj = zipFileInput;
    } else {
      throw new Error('LoadGTFSZipFile: unsupported input type. Provide a File, ArrayBuffer, Uint8Array, or unzipped object.');
    }

    // If fallback path, do per-file size check as before (we have internal files)
    const maxSize = 500 * 1024 * 1024; // 500MB
    if (fallbackZipObj) {
      for (const fname of ['stops.txt','routes.txt','trips.txt','shapes.txt','stop_times.txt']) {
        const arr = fallbackZipObj[fname];
        if (arr && arr.length > maxSize) {
          alert(`${fname} is too large (${(arr.length / (1024*1024)).toFixed(1)} MB). Please use a smaller GTFS file (max 500 MB per file).`);
          hideProgressBar();
          return;
        }
      }
    } else {
      // optional: check rawZipBuffer overall size (not per-file)
      if (rawZipBuffer.byteLength && rawZipBuffer.byteLength > 1024 * 1024 * 1024) { // 1GB arbitrary guard
        // warn but not block
        console.warn('Raw zip is very large:', rawZipBuffer.byteLength);
      }
    }

    // prepare variables for weighted progress (we'll fill weights after worker posts file sizes)
    const fileProgress = {};
    const weights = {};
    let lastOverall = 0;
    let worker = null;

    const results = await new Promise((resolve, reject) => {
      worker = new Worker('gtfsWorker.js');

      // When worker posts file sizes, we initialize weights and progress map
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;

        if (msg.type === 'files') {
          // msg.files: { 'stops.txt': length, ... }
          const filesObj = msg.files || {};
          // compute weights by byte length
          let total = 0;
          Object.keys(filesObj).forEach(f => { total += filesObj[f] || 0; });
          if (total > 0) {
            Object.keys(filesObj).forEach(f => {
              weights[f] = (filesObj[f] || 0) / total;
              fileProgress[f] = 0;
            });
          } else {
            // fallback equal weights
            const keys = Object.keys(filesObj);
            const w = keys.length ? 1 / keys.length : 0;
            keys.forEach(f => { weights[f] = w; fileProgress[f] = 0; });
          }
          // small visual bump after init
          setProgressBar(8);
        } else if (msg.type === 'status') {
          // show small visual bump on status messages
          setProgressBar(Math.max(lastOverall, 8));
          console.log('[Worker status]', msg.message);
        } else if (msg.type === 'progress') {
          // update per-file progress
          if (msg.file && weights[msg.file] !== undefined) {
            fileProgress[msg.file] = Math.max(0, Math.min(1, msg.progress || 0));
          } else if (msg.file) {
            // unknown file - add minimal weight (optional)
            if (fileProgress[msg.file] === undefined) { fileProgress[msg.file] = Math.max(0, Math.min(1, msg.progress || 0)); weights[msg.file] = 0.0001; }
            else fileProgress[msg.file] = Math.max(fileProgress[msg.file], Math.max(0, Math.min(1, msg.progress || 0)));
          }

          // compute weighted average
          let weighted = 0;
          let sumW = 0;
          Object.keys(weights).forEach(f => {
            const w = weights[f] || 0;
            weighted += w * (fileProgress[f] || 0);
            sumW += w;
          });
          const avg = sumW > 0 ? (weighted / sumW) : 0;

          // map avg to 10..90 and ensure monotonic progress
          let overall = 10 + Math.round(avg * 80);
          overall = Math.max(lastOverall, overall);
          lastOverall = overall;
          setProgressBar(overall);

        } else if (msg.type === 'done') {
          resolve(msg.results);
        } else if (msg.type === 'error') {
          reject(new Error(msg.message || 'Worker error'));
        }
      };

      worker.onerror = (errEv) => {
        reject(errEv.error || new Error('Worker runtime error'));
      };

      // Send data to worker.
      // Preferred: transfer rawZipBuffer (zero-copy)
      if (rawZipBuffer) {
        // ensure we have an ArrayBuffer to transfer
        const ab = (rawZipBuffer instanceof ArrayBuffer) ? rawZipBuffer : rawZipBuffer.buffer || rawZipBuffer;
        worker.postMessage({ rawZip: ab }, [ab]);
      } else if (fallbackZipObj) {
        // fallback: send pre-unzipped files as before; transfer each buffer to avoid copying when possible
        const transfer = [];
        const cloneable = {};
        Object.keys(fallbackZipObj).forEach(k => {
          const v = fallbackZipObj[k];
          cloneable[k] = v;
          if (v && v.buffer) transfer.push(v.buffer);
          else if (v instanceof ArrayBuffer) transfer.push(v);
        });
        worker.postMessage({ zipFile: cloneable }, transfer);
      } else {
        reject(new Error('No zip data to send to worker'));
      }
    });

    // worker done; terminate
    if (worker) {
      try { worker.terminate(); } catch (e) {}
      worker = null;
    }

    // UI bump to show near-complete parsing
    setProgressBar(95);

    // assign results back to your globals (unchanged from earlier)
    stops = results.stops || [];
    if (results.stopsById && !(results.stopsById instanceof Map)) {
      stopsById = new Map(Object.entries(results.stopsById || {}).map(([k,v]) => [k, v]));
    } else {
      stopsById = results.stopsById || new Map();
    }

    shapes = results.shapes || [];
    shapesById = results.shapesById || {};
    shapeIdToDistance = results.shapeIdToDistance || {};
    routes = results.routes || [];
    trips = results.trips || [];
    stopTimesByTripId = results.stopTimesByTripId || {};
    stopTimes = [];    //not building stopTimes here

    tripStartTimeMap = results.tripStartTimeMap || {};

    if (results.tripStopsMap) {
      tripStopsMap = results.tripStopsMap; // Now an array of stop_ids in correct order
    } else {
      tripStopsMap = {};
    }

    calendar = results.calendar || [];
    calendarDates = results.calendar_dates || [];

    // post-parse initialization
    buildServiceDateDict();
    initializeTripsRoutes(trips, routes);
    plotFilteredStopsAndShapes();

    setProgressBar(100);
    setTimeout(hideProgressBar, 500);
    updateServiceDateFilterUI();

  } catch (err) {
    hideProgressBar();
    console.error('Failed to process GTFS ZIP:', err);
  }
}



let shapeIdToDistance = {};
function buildShapeIdToDistance() {
  shapeIdToDistance = {};
  // Group shape points by shape_id
  const shapesById = {};
  shapes.forEach(s => {
    if (!shapesById[s.shape_id]) shapesById[s.shape_id] = [];
    shapesById[s.shape_id].push(s);
  });
  Object.entries(shapesById).forEach(([shape_id, pts]) => {
    shapeIdToDistance[shape_id] = shapeDistance(pts);
  });
}

function clearAllMapLayersAndMarkers() {
  // Remove stops layer if present
  if (stopsLayer && map.hasLayer(stopsLayer)) {
    map.removeLayer(stopsLayer);
    stopsLayer = null;
  }
  // Remove shapes layer if present
  if (shapesLayer && map.hasLayer(shapesLayer)) {
    map.removeLayer(shapesLayer);
    shapesLayer = null;
  }
  // Remove all vehicle markers
  if (Array.isArray(allVehicleMarkers)) {
    allVehicleMarkers.forEach(marker => {
      if (marker && map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
    });
    allVehicleMarkers = [];
  }
  vehicleMarkersWithActiveTrip = [];

  // Also clear tripPaths and remainingTrips for safety
  tripPaths = [];
  remainingTrips = [];
    // Clear global GTFS data
  stops = [];
  shapes = [];
  routes = [];
  trips = [];
  stopTimes = [];
  // Clear filter & animation state
  routeTypes = [];
  serviceIds = [];
  filteredTrips = [];
  // Clear precomputed maps
  tripStartTimeMap = {};
  tripStopsMap = {};
  // Clear short-name lookup
  shortAndLongNamesByType = {};
  shortNameToServiceIds = {};
  // Clear animation state
  animationTime = null;
  animationStartTime = null;
  currentTrip = null;
}


//#region ParseData
function parseStopsIntoMap(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idIndex = headers.indexOf('stop_id');
  const nameIndex = headers.indexOf('stop_name');
  const latIndex = headers.indexOf('stop_lat');
  const lonIndex = headers.indexOf('stop_lon');

  if (latIndex === -1 || lonIndex === -1) {
    throw new Error('Missing stop_lat or stop_lon columns in stops.txt');
  }

  stops = [];
  stopsById = new Map();

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const cols = row.split(','); // still naive but same interface as before
    const obj = {
      id: cols[idIndex] ? cols[idIndex].trim() : '',
      name: cols[nameIndex] ? cols[nameIndex].trim() : '',
      lat: parseFloat(cols[latIndex]),
      lon: parseFloat(cols[lonIndex])
    };
    stops.push(obj);
    if (obj.id) stopsById.set(obj.id, obj);
  }

  return stops;
}


function parseShapesIntoGroups(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const shapeIDIndex = headers.indexOf('shape_id');
  const shapeLatIndex = headers.indexOf('shape_pt_lat');
  const shapeLonIndex = headers.indexOf('shape_pt_lon');
  const shapeSeqIndex = headers.indexOf('shape_pt_sequence');
  const shapeDistIndex = headers.indexOf('shape_dist_traveled');

  if (shapeIDIndex === -1 || shapeLatIndex === -1 || shapeLonIndex === -1 || shapeSeqIndex === -1) {
    throw new Error('Missing required columns in shapes.txt');
  }

  // We'll also maintain the original `shapes` flat array for compatibility
  shapes = [];
  shapesById = {};

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const cols = row.split(',');
    const sid = cols[shapeIDIndex] ? cols[shapeIDIndex].trim() : '';
    const lat = parseFloat(cols[shapeLatIndex]);
    const lon = parseFloat(cols[shapeLonIndex]);
    const seq = parseInt(cols[shapeSeqIndex], 10);
    const dist = shapeDistIndex !== -1 ? parseFloat(cols[shapeDistIndex]) : undefined;

    const obj = { shape_id: sid, lat, lon, sequence: seq, shape_dist_traveled: dist };
    shapes.push(obj);
    if (!shapesById[sid]) shapesById[sid] = [];
    shapesById[sid].push(obj);
  }

  // Sort each shape's points by sequence and compute cumulative distances (single pass per shape)
  shapeCumulativeDist = {};
  shapeIdToDistance = {}; // keep alias used elsewhere
  Object.keys(shapesById).forEach(id => {
    const pts = shapesById[id];
    pts.sort((a,b) => a.sequence - b.sequence);
    // compute cumulative distances
    const cum = [0];
    for (let k = 1; k < pts.length; k++) {
      const d = calculateDistance(pts[k-1].lat, pts[k-1].lon, pts[k].lat, pts[k].lon);
      cum.push(cum[cum.length - 1] + d);
    }
    shapeCumulativeDist[id] = cum;
    shapeIdToDistance[id] = cum.length ? cum[cum.length - 1] : 0;
  });

  return shapes;
}


function parseRoutes(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

  const routeIdIndex = headers.indexOf('route_id');
  const shortNameIndex = headers.indexOf('route_short_name');
  const longNameIndex = headers.indexOf('route_long_name');
  const typeIndex = headers.indexOf('route_type');

  if (routeIdIndex === -1 || typeIndex === -1) {
    throw new Error('Missing required columns in routes.txt');
  }

  return lines.slice(1).map(row => {
    const cols = row.split(',').map(col => col.trim());
    return {
      route_id: cols[routeIdIndex],
      route_short_name: cols[shortNameIndex] || '',
      route_long_name: cols[longNameIndex] || '',
      route_type: cols[typeIndex]
    };
  });
}


function parseTrips(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

  const routeIdIndex = headers.indexOf('route_id');
  const serviceIdIndex = headers.indexOf('service_id');
  const tripIdIndex = headers.indexOf('trip_id');
  const shapeIdIndex = headers.indexOf('shape_id');
  const blockIDIndex = headers.indexOf('block_id');
  const directionIdIndex = headers.indexOf('direction_id');
  
  if (routeIdIndex === -1 || serviceIdIndex === -1 || tripIdIndex === -1) {
    throw new Error('Missing required columns in trips.txt');
  }
  if (blockIDIndex === -1) {
    console.warn('block_id column not found in trips.txt. Vehicle animation will not connect trips by block.');
  }
  if (directionIdIndex === -1) {
    console.warn('direction_id column not found in trips.txt. Trips-per-hour graph will not be split by direction.');
  }


  return lines.slice(1).map(row => {
    const cols = row.split(',').map(col => col.trim());
    return {
      route_id: cols[routeIdIndex],
      service_id: cols[serviceIdIndex],
      trip_id: cols[tripIdIndex],
      shape_id: shapeIdIndex !== -1 ? cols[shapeIdIndex] : undefined,
      block_id: blockIDIndex !== -1 ? cols[blockIDIndex] : undefined,
      direction_id: directionIdIndex !== -1 ? cols[directionIdIndex] : undefined
    };
  });
}

function parseStopTimesIntoIndexes(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {
    trip_id: headers.indexOf('trip_id'),
    arrival_time: headers.indexOf('arrival_time'),
    departure_time: headers.indexOf('departure_time'),
    stop_id: headers.indexOf('stop_id'),
    stop_sequence: headers.indexOf('stop_sequence')
  };

  if (idx.trip_id === -1 || idx.stop_id === -1 || idx.stop_sequence === -1) {
    throw new Error('Missing required columns in stop_times.txt');
  }

  stopTimes = []; // keep flat array for compatibility
  stopTimesByTripId = {};
  tripStartTimeMap = {}; // clear and build here
  tripStopsMap = {};     // clear and build here

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row) continue;
    const cols = row.split(',');
    const tripId = cols[idx.trip_id] ? cols[idx.trip_id].trim() : '';
    const stopId = cols[idx.stop_id] ? cols[idx.stop_id].trim() : '';
    const seq = parseInt(cols[idx.stop_sequence], 10) || 0;
    const arrival = cols[idx.arrival_time] ? cols[idx.arrival_time].trim() : '';
    const departure = cols[idx.departure_time] ? cols[idx.departure_time].trim() : (arrival || '');
    const departureSec = departure ? timeToSeconds(departure) : null;

    const stObj = {
      trip_id: tripId,
      arrival_time: arrival,
      departure_time: departure,
      stop_id: stopId,
      stop_sequence: seq,
      departure_sec: departureSec
    };
    stopTimes.push(stObj);

    if (!stopTimesByTripId[tripId]) stopTimesByTripId[tripId] = [];
    stopTimesByTripId[tripId].push(stObj);

    if (!tripStopsMap[tripId]) tripStopsMap[tripId] = [];
    if (stopId) tripStopsMap[tripId].push({ stop_id: stopId, stop_sequence: seq });

    if (departureSec !== null) {
      const t = tripStartTimeMap[tripId];
      if (t === undefined || departureSec < t) tripStartTimeMap[tripId] = departureSec;
    }
  }
  // sort each trip's stop_times by stop_sequence
  Object.keys(stopTimesByTripId).forEach(tid => {
    stopTimesByTripId[tid].sort((a,b) => a.stop_sequence - b.stop_sequence);
  });

  Object.keys(tripStopsMap).forEach(tripId => {
    tripStopsMap[tripId].sort((a, b) => a.stop_sequence - b.stop_sequence);
    tripStopsMap[tripId] = tripStopsMap[tripId].map(obj => obj.stop_id);
  });

  return stopTimes;
}

// --- Calendar Parsing ---
function parseCalendar(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {};
  ['service_id','monday','tuesday','wednesday','thursday','friday','saturday','sunday','start_date','end_date'].forEach(k => {
    idx[k] = headers.indexOf(k);
  });
  return lines.slice(1).map(row => {
    const cols = row.split(',').map(col => col.trim());
    return {
      service_id: cols[idx['service_id']],
      days: {
        monday: +cols[idx['monday']],
        tuesday: +cols[idx['tuesday']],
        wednesday: +cols[idx['wednesday']],
        thursday: +cols[idx['thursday']],
        friday: +cols[idx['friday']],
        saturday: +cols[idx['saturday']],
        sunday: +cols[idx['sunday']]
      },
      start_date: cols[idx['start_date']],
      end_date: cols[idx['end_date']]
    };
  });
}

function parseCalendarDates(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {
    service_id: headers.indexOf('service_id'),
    date: headers.indexOf('date'),
    exception_type: headers.indexOf('exception_type')
  };
  return lines.slice(1).map(row => {
    const cols = row.split(',').map(col => col.trim());
    return {
      service_id: cols[idx.service_id],
      date: cols[idx.date],
      exception_type: +cols[idx.exception_type] // 1=add, 2=remove
    };
  });
}


// --- Build Service-Date Dictionary ---
function buildServiceDateDict() {
  serviceDateDict = {};
  genericWeekdayDates = {};
  serviceDateFilterMode = false;

  // Helper: get all dates between two YYYYMMDD (inclusive)
  function getDatesBetween(start, end) {
    const dates = [];
    let d = new Date(
      +start.slice(0,4), +start.slice(4,6)-1, +start.slice(6,8)
    );
    const endD = new Date(
      +end.slice(0,4), +end.slice(4,6)-1, +end.slice(6,8)
    );
    while (d <= endD) {
      const ymd = d.toISOString().slice(0,10).replace(/-/g,'');
      dates.push(ymd);
      d.setDate(d.getDate()+1);
    }
    return dates;
  }

  // 1. If calendar.txt exists, enumerate all dates for each service_id
  if (calendar.length) {
    for (const cal of calendar) {
      const allDates = getDatesBetween(cal.start_date, cal.end_date);
      for (const date of allDates) {
        const dt = new Date(+date.slice(0,4), +date.slice(4,6)-1, +date.slice(6,8));
        const weekday = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dt.getDay()];
        if (cal.days[weekday]) {
          if (!serviceDateDict[date]) serviceDateDict[date] = new Set();
          serviceDateDict[date].add(cal.service_id);
        }
      }
    }
  }

  // 2. Apply calendar_dates.txt (add/remove service_id for date)
  if (calendarDates.length) {
    for (const cd of calendarDates) {
      if (!serviceDateDict[cd.date]) serviceDateDict[cd.date] = new Set();
      if (cd.exception_type === 1) {
        serviceDateDict[cd.date].add(cd.service_id);
      } else if (cd.exception_type === 2) {
        serviceDateDict[cd.date].delete(cd.service_id);
      }
    }
  }

  // 3. If no calendar.txt, but calendar_dates.txt exists, build from calendar_dates only
  if (!calendar.length && calendarDates.length) {
    for (const cd of calendarDates) {
      if (!serviceDateDict[cd.date]) serviceDateDict[cd.date] = new Set();
      if (cd.exception_type === 1) {
        serviceDateDict[cd.date].add(cd.service_id);
      } else if (cd.exception_type === 2) {
        serviceDateDict[cd.date].delete(cd.service_id);
      }
    }
  }

  // 4. Build generic weekdays if possible (at least 3 dates per weekday with no calendar_dates modification)
  if (calendar.length) {
    // Find all dates with no calendar_dates modification
    const modifiedDates = new Set(calendarDates.map(cd => cd.date));
    const weekdayDates = { monday:[], tuesday:[], wednesday:[], thursday:[], friday:[], saturday:[], sunday:[] };
    for (const date in serviceDateDict) {
      if (modifiedDates.has(date)) continue;
      const dt = new Date(+date.slice(0,4), +date.slice(4,6)-1, +date.slice(6,8));
      const weekday = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dt.getDay()];
      weekdayDates[weekday].push(date);
    }
    // For each weekday, if at least 3 dates with no modification, create a "Monday (Generic)" etc entry
    for (const wd in weekdayDates) {
      //console.log(`Weekday ${wd} has ${weekdayDates[wd].length} unmodified dates`);      
      if (weekdayDates[wd].length >= 3) {
        const label = wd.charAt(0).toUpperCase() + wd.slice(1) + ' (Generic)';
        genericWeekdayDates[label] = weekdayDates[wd].slice(0, 3); // pick first 3
      }
    }
  }

  // 5. If at least one file exists, enable service-date filter
  if (calendar.length || calendarDates.length) {
    serviceDateFilterMode = true;
  }
}


// --- UI: Show/hide Service-Date or Service ID filter ---
function updateServiceDateFilterUI() {
  const serviceIdLabel = document.getElementById('serviceIdLabel');
  const serviceIdSelect = document.getElementById('serviceIdSelect');
  const serviceDateLabel = document.getElementById('serviceDateLabel');
  const serviceDateSelect = document.getElementById('serviceDateSelect');

  if (serviceDateFilterMode) {
    // Show service-date, hide serviceId
    serviceDateLabel.style.display = '';
    serviceIdLabel.style.display = 'none';
    serviceIdSelect.style.display = 'none';

    // Build options: generic weekdays first, then all dates sorted
    let options = [];
    for (const label in genericWeekdayDates) {
      options.push(`<option value="GENERIC:${label}">${label}</option>`);
    }
    // List all dates (YYYYMMDD) sorted
    const allDates = Object.keys(serviceDateDict).sort();
    for (const date of allDates) {
      const y = date.slice(0,4), m = date.slice(4,6), d = date.slice(6,8);
      options.push(`<option value="${date}">${y}-${m}-${d}</option>`);
    }
    serviceDateSelect.innerHTML = options.join('');
    
    // --- Limit to 2 selections ---
    serviceDateSelect.onchange = function(e) {
      const selected = Array.from(this.selectedOptions);
      if (selected.length > 2) {
        // Deselect the last selected option
        selected[selected.length - 1].selected = false;
        alert('You can select up to 2 service dates only.');
      }
      filterTrips();
    };
  } else {
    // Hide service-date, show serviceId
    serviceDateLabel.style.display = 'none';
    serviceIdLabel.style.display = '';
    serviceIdSelect.style.display = '';
  }
}

//#endregion  ParseData



// === Data Relationships & Filters ===
function initializeTripsRoutes(tripsArr, routesArr) {
  shortAndLongNamesByType = {};

  const routeMap = new Map(routesArr.map(r=>[r.route_id,r]));
  routeTypes = [...new Set(routesArr.map(r => r.route_type))];
  serviceIds = [...new Set(tripsArr.map(t => t.service_id))];
  
   // Assign route object to each trip first!
  tripsArr.forEach(t => t.route = routeMap.get(t.route_id));

  // Build shortNamesByType per route_type
  routesArr.forEach(r => {
    if (!shortAndLongNamesByType[r.route_type]) shortAndLongNamesByType[r.route_type] = new Set();
    shortAndLongNamesByType[r.route_type].add(`${r.route_short_name}-${r.route_long_name}`);
  });

  shortNameToServiceIds = {}; // Reset mapping
  tripsArr.forEach(t => {
    const key = `${t.route.route_short_name}-${t.route.route_long_name}`;
    if (!shortNameToServiceIds[key]) shortNameToServiceIds[key] = new Set();
    shortNameToServiceIds[key].add(t.service_id);
  });

    // convert to arrays
  Object.keys(shortAndLongNamesByType).forEach(rt => {
    shortAndLongNamesByType[rt] = [...shortAndLongNamesByType[rt]].sort();
  });

  tripsArr.forEach(t=>t.route=routeMap.get(t.route_id));
  populateFilters();
}

function populateFilters() {
  const rtSel = document.getElementById('routeTypeSelect');
  const shSel = document.getElementById('routeShortNameSelect'); 
  const svSel = document.getElementById('serviceIdSelect');
  const sdSel = document.getElementById('serviceDateSelect');

  rtSel.innerHTML = routeTypes.map(v => {
    const label = ROUTE_TYPE_NAMES[v] ? `${v} - ${ROUTE_TYPE_NAMES[v]}` : v;
    return `<option value="${v}">${label}</option>`;
  }).join('');
  svSel.innerHTML = serviceIds.map(v=>`<option value="${v}">${v}</option>`).join('');
  rtSel.onchange = filterTrips;
  svSel.onchange = filterTrips;

  // When route‐type changes, update short‐names dropdown
  rtSel.onchange = () => {
    const chosen = Array.from(rtSel.selectedOptions).map(o => o.value);
    let names = new Set();

    chosen.forEach(rt => {
      (shortAndLongNamesByType[rt] || []).forEach(n => {names.add(n);});
    });
    
    shSel.innerHTML = [...names].sort().map(n => `<option value="${n}">${n}</option>`).join('');
    filterTrips();
    shSel.dispatchEvent(new Event('change')); // trigger short name change
  };

  // When short-name changes, update service IDs dropdown
  shSel.onchange = () => {
    const chosenNames = Array.from(shSel.selectedOptions).map(o => o.value);
    let validServiceIds = new Set();
    chosenNames.forEach(name => {
      (shortNameToServiceIds[name] || []).forEach(sid => validServiceIds.add(sid));
    });
    svSel.innerHTML = [...validServiceIds].sort().map(sid => `<option value="${sid}">${sid}</option>`).join('');
    filterTrips();
  };

  svSel.onchange = filterTrips;

  // Service-date filter
  if (sdSel) {
    sdSel.onchange = filterTrips;
  }

  // trigger initial population of short names
  rtSel.dispatchEvent(new Event('change'));
}

let filteredTrips1 = [];
let filteredTrips2 = [];

function filterTrips() {
  const types = Array.from(document.getElementById('routeTypeSelect').selectedOptions).map(o => o.value);
  const names = Array.from(document.getElementById('routeShortNameSelect').selectedOptions).map(o => o.value);
  
  filteredTrips1 = [];
  filteredTrips2 = [];

  if (serviceDateFilterMode) {
    const sdSel = document.getElementById('serviceDateSelect');
    const selectedDates = Array.from(sdSel.selectedOptions).map(o => o.value);

    let selectedServiceIdsArr = [];
    for (const val of selectedDates) {
      let ids = new Set();
      if (val.startsWith('GENERIC:')) {
        const label = val.slice(8);
        (genericWeekdayDates[label] || []).forEach(date => {
          (serviceDateDict[date] || []).forEach(sid => ids.add(sid));
        });
      } else {
        (serviceDateDict[val] || []).forEach(sid => ids.add(sid));
      }
      selectedServiceIdsArr.push(ids);
    }

    // Filter for each service date
    if (selectedServiceIdsArr.length > 0) {
      filteredTrips1 = trips.filter(t =>
        types.includes(t.route.route_type) &&
        names.includes(`${t.route.route_short_name}-${t.route.route_long_name}`) &&
        selectedServiceIdsArr[0].has(t.service_id)
      );
    }
    if (selectedServiceIdsArr.length > 1) {
      filteredTrips2 = trips.filter(t =>
        types.includes(t.route.route_type) &&
        names.includes(`${t.route.route_short_name}-${t.route.route_long_name}`) &&
        selectedServiceIdsArr[1].has(t.service_id)
      );
    }
    
    const tripMap = new Map();
    [...filteredTrips1, ...filteredTrips2].forEach(t => {
      tripMap.set(t.trip_id, t);
    });
    filteredTrips = Array.from(tripMap.values());

  } else {
    const services = Array.from(document.getElementById('serviceIdSelect').selectedOptions).map(o => o.value);
    filteredTrips = trips.filter(t =>
      types.includes(t.route.route_type) &&
      names.includes(`${t.route.route_short_name}-${t.route.route_long_name}`) &&
      services.includes(t.service_id)
    );
    filteredTrips1 = filteredTrips;
    filteredTrips2 = [];
  }

  //clear and rebuild stopTimes for filteredTrips
  stopTimes = [];
  for (const trip of filteredTrips) {
    if (stopTimesByTripId[trip.trip_id]) {
      stopTimes.push(...stopTimesByTripId[trip.trip_id]);
    }
  }
}

// Skip markercluster plugin overhead entirely below this count
let skipAggregatingStopThreshold = 200;
function plotFilteredStopsAndShapes(tripsToShow) {
  // Remove old layers
  if (stopsLayer && map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
  if (shapesLayer && map.hasLayer(shapesLayer)) map.removeLayer(shapesLayer);

  // --- decide which stops/shapes to plot (unchanged) ---
  let stopsToPlot, shapesToPlot;

  if (Array.isArray(tripsToShow) && tripsToShow.length > 0) {
    const usedStops = new Set();
    const usedShapes = new Set();
    tripsToShow.forEach(t => {
      usedShapes.add(t.shape_id);
      (tripStopsMap[t.trip_id] || []).forEach(id => usedStops.add(id));
    });
    stopsToPlot = stops.filter(s => usedStops.has(s.id));
    shapesToPlot = shapes.filter(s => usedShapes.has(s.shape_id));
  } else {
    stopsToPlot = stops;
    shapesToPlot = shapes;
  }

  // --- Adaptive clustering: scale cluster radius by number of stops (continuous) ---
  const totalStops = stopsToPlot.length;

  // Parameters you can tune:
  const basePixels = 60;         // pixel radius at ref zoom when scale==1
  const refZoom = 14;            // zoom where basePixels is meaningful
  const clampMaxPx = 100;        // absolute max pixel radius to avoid giant bubbles
  const minMultiplier = 0.20;    // smallest fraction of basePixels when stops are few
  const minCount = 200;          // lower edge of scaling (below this -> mostly small radius)
  const maxCount = 3000;        // upper edge of scaling (above this -> full radius)

  // smoothstep helper: maps x in [a,b] -> 0..1 smoothly
  function smoothstep(a, b, x) {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
  }

  // map count -> scale [0..1]
  const rawScale = smoothstep(minCount, maxCount, totalStops);
  // final multiplier between minMultiplier .. 1.0
  const multiplier = minMultiplier + (1 - minMultiplier) * rawScale;

  // Create stopsLayer using a radius function that incorporates multiplier
  stopsLayer = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({
        chunkedLoading: true,
        // maxClusterRadius gets zoom param -> return pixel radius
        maxClusterRadius: function (zoom) {
          // exponential zoom scaling (same idea as before): basePixels * 2^(refZoom - zoom)
          const zoomScaledBase = basePixels * Math.pow(2, refZoom - zoom);
          const px = Math.max(6, Math.round(zoomScaledBase * multiplier));
          return Math.min(clampMaxPx, px);
        },
        chunkInterval: 200,
        chunkDelay: 40
      })
    : L.layerGroup();

     if (totalStops <= skipAggregatingStopThreshold) stopsLayer = L.layerGroup();

  // --- Add clustered stops ---
  for (const stop of stopsToPlot) {
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      color: 'red',
      fillColor: 'red',
      fillOpacity: 0.8
    }).bindTooltip(stop.name);
    stopsLayer.addLayer(marker);
  }

  // --- Add shapes (unchanged) ---
  shapesLayer = L.layerGroup();
  const shapesById = {};
  for (const s of shapesToPlot) {
    if (!shapesById[s.shape_id]) shapesById[s.shape_id] = [];
    shapesById[s.shape_id].push(s);
  }
  for (const shape_id in shapesById) {
    const shapePoints = shapesById[shape_id]
      .sort((a, b) => a.sequence - b.sequence)
      .map(s => [s.lat, s.lon]);
    const polyline = L.polyline(shapePoints, {
      color: 'blue',
      weight: 2
    });
    shapesLayer.addLayer(polyline);
  }

  stopsLayer.addTo(map);
  shapesLayer.addTo(map);

  // Fit bounds
  const allCoords = [
    ...stopsToPlot.map(s => [s.lat, s.lon]),
    ...shapesToPlot.map(s => [s.lat, s.lon])
  ];
  if (allCoords.length) {
    const bounds = L.latLngBounds(allCoords);
    map.fitBounds(bounds);
  }

  // --- Debug / tuning logs (remove in production) ---
  // console.log('stopsCount=', totalStops, 'scale=', rawScale.toFixed(2), 'mult=', multiplier.toFixed(2));
}


function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// === Utility: Parse HH:MM:SS into seconds ===
function timeToSeconds(t) {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// === Interpolate times between stops (distance-based) ===
function interpolateTripPath(trip) {
  const tripStops = stopTimes.filter(st=>st.trip_id===trip.trip_id).sort((a,b)=>a.stop_sequence-b.stop_sequence);
  const shapePts = shapes.filter(s=>s.shape_id===trip.shape_id).sort((a,b)=>a.sequence-b.sequence);
  const stopPositions = tripStops.map(st=>{
    const stop = stops.find(s=>s.id===st.stop_id);
    return { lat:stop.lat, lon:stop.lon, time: timeToSeconds(st.departure_time) };
  });

  const timedPath = [];
  let idxStop = 0;
  for(let i=0;i<shapePts.length;i++){
    const {lat,lon} = shapePts[i];
    if(idxStop>=stopPositions.length-1) break;
    const curr = stopPositions[idxStop], next=stopPositions[idxStop+1];
    const dTotal=calculateDistance(curr.lat,curr.lon,next.lat,next.lon);
    const dCur=calculateDistance(curr.lat,curr.lon,lat,lon);
    if(dCur>dTotal) { idxStop++; if(idxStop>=stopPositions.length-1) break; }
    const prog = dTotal>0? dCur/dTotal:0;
    const time = curr.time + (next.time-curr.time)*prog;
    timedPath.push({lat,lon,time});
  }
  return timedPath;
}

// === Animation Controls ===
function initializeAnimation() {
  // Clear the trip plot data
  tripPlotData.labels = [];
  tripPlotData.datasets[0].data = [];
  tripPlotData.datasets[1].data = [];
  if (tripPlotChart) tripPlotChart.update();
  hourTicks = [];

  //clear the vehicle km chart data
  vehKmData = {};
  if (vehKmChart) {
    vehKmChart.data.datasets = [];
    vehKmChart.options.scales.x.min = undefined;
    vehKmChart.update();
  }

  // For coloring and plotting
  window.tripIds1 = new Set(filteredTrips1.map(t => t.trip_id));
  window.tripIds2 = new Set(filteredTrips2.map(t => t.trip_id));

  if (!filteredTrips.length) { alert('No trips match filters'); return; }
  // compute startTime for filtered trips and find earliest

  // filter geometry
  plotFilteredStopsAndShapes(filteredTrips);

  // prepare remaining
  remainingTrips = filteredTrips.map(t => {
    t.startTime = tripStartTimeMap[t.trip_id] ?? null;
    return t;
  }).filter(t => t.startTime != null);

  blockIdTripMap = {};
  remainingTrips.forEach(t => {
    if (!blockIdTripMap[t.block_id]) blockIdTripMap[t.block_id] = [];
    blockIdTripMap[t.block_id].push(t);
  });
  // Sort each block's trips by startTime
  Object.values(blockIdTripMap).forEach(arr => arr.sort((a, b) => a.startTime - b.startTime));
  Object.values(blockIdTripMap).forEach(tripArr => {for (let i = 0; i < tripArr.length - 1; i++) {tripArr[i].nextTrip = tripArr[i + 1];}
  });

  tripPaths = [];
  if (Array.isArray(vehicleMarkersWithActiveTrip)) {
    vehicleMarkersWithActiveTrip.forEach(m => { if (m) map.removeLayer(m); });
  }

  vehicleMarkersWithActiveTrip = [];
  animationTime = Infinity;
  lastTripsPerHourUpdateHour = null;
  tripsPerHourSeries = {};

  buildMostCommonShapeIdByRouteDir();

  // determine earliest start time among remainingTrips
  animationTime = remainingTrips.reduce((min, t) => Math.min(min, t.startTime), Infinity);

  if (animationTime === Infinity) { alert('No valid stop times'); return; }
  animationStartTime = animationTime;
  document.getElementById('timeDisplay').textContent = formatTime(animationTime);
}

function startAnimation() {
  if (animationTime == null) return;
  if (animationTimer) return;
  animationTimer = setInterval(() => {
    UpdateAnimationOnAnimationTimeChange();
  }, FRAME_INTERVAL_MS);
}

function UpdateAnimationOnAnimationTimeChange(){
  animationTime += TIME_STEP_SEC * speedMultiplier;
  UpdateVehiclePositions();
  updateTripPlot(animationTime);
  document.getElementById('timeDisplay').textContent = formatTime(animationTime);
  flushVehKmPendingPoints();

  const currentHour = Math.floor(animationTime / 3600);
  if (lastTripsPerHourUpdateHour === null || currentHour > lastTripsPerHourUpdateHour) {
    updateHeadwayPlotForHour(currentHour - 1); // Show stats for the previous hour
    lastTripsPerHourUpdateHour = currentHour;
  }
}


function UpdateVehiclePositions(){
    // activate trips whose startTime <= now
    remainingTrips = remainingTrips.filter(t=>{
      if(t.startTime<=animationTime) {
        const path = interpolateTripPath(t);
        path.parentTrip = t;  // Store reference to parent trip        
        if(path.length) {
          tripPaths.push(path);
          // If inheriting marker from previous block, use it
          if (t._inheritedMarker) {
            vehicleMarkersWithActiveTrip.push(t._inheritedMarker);
            if(!allVehicleMarkers.includes(t._inheritedMarker)) {
              allVehicleMarkers.push(t._inheritedMarker);
            }else{
            }
          } else {
            const m = L.circleMarker([path[0].lat, path[0].lon], {
              radius: 6,
              color: (window.tripIds2 && window.tripIds2.has(t.trip_id) && (!window.tripIds1 || !window.tripIds1.has(t.trip_id))) ? 'orange' : 'green',
              fillColor: (window.tripIds2 && window.tripIds2.has(t.trip_id) && (!window.tripIds1 || !window.tripIds1.has(t.trip_id))) ? 'orange' : 'green',
              fillOpacity: 1
            }).addTo(map);
            m.parentTrip = t; // Store reference to parent trip
            allVehicleMarkers.push(m);
            vehicleMarkersWithActiveTrip.push(m);
          }
        }
        return false;
      }
      return true;
    });

  // Update active vehicles and remove finished ones
    for (let i = tripPaths.length - 1; i >= 0; i--) {
      const path = tripPaths[i];
      const endTime = path[path.length - 1].time;
      if (animationTime >= endTime) {
        // Trip finished: try to connect to next trip with same block_id
        const finishedTrip =path.parentTrip;
        //console.log(`Trip ${finishedTrip.trip_id} finished at ${formatTime(endTime)}. Trying to find next connection`);

        if (finishedTrip){
            //update the veh-kilometer plot
            const shapePts = shapes.filter(s => s.shape_id === finishedTrip.shape_id);
            let tripDistanceKm = 0;
            if (shapePts.length > 1) {
              tripDistanceKm = shapeDistance(shapePts);
            }
            updateVehKmOnTripFinish(finishedTrip, tripDistanceKm, endTime);
        }

        if (finishedTrip && finishedTrip.block_id) {
          const tripsForBlock = blockIdTripMap[finishedTrip.block_id] || [];
          // Find the next trip with startTime > endTime
          const nextTrip = finishedTrip.nextTrip;
            if (nextTrip && nextTrip.startTime > endTime && remainingTrips.includes(nextTrip)) {
            //there is a next trip with the same blockID
            // Calculate distance and layover
            const endPos = path[path.length - 1];
            const stopIds = tripStopsMap[nextTrip.trip_id];
            const startStopId = stopIds ? stopIds[0] : null;
            const startStop = stops.find(s => s.id === startStopId);
                    
            const dist = calculateDistance(endPos.lat, endPos.lon, startStop.lat, startStop.lon);
            const layover = nextTrip.startTime - endTime;
            let msg = `Block ${finishedTrip.block_id} involving trips ${finishedTrip.trip_id} and ${nextTrip.trip_id}: Layover ${Math.round(layover / 60)} min, Distance ${Math.round(dist)} m`;

            if ((layover > 7200) || ((dist > 400 || layover < 7200) && (dist / layover > 5))) {
              //if the two trips are > 2hrs apart, treat them as two unrelated trips
              //another case is if the trips are >400m apart and within 2hrs connection, and the speed is > 5m/s (18km/h). Treat this case as if the block_id is miscoded, and the trip is not the same physical vehicl
              msg += " ALERT: This is not considered a connection although the trips share the same block_id";
              msg += `DEBUG: endPos=${endPos.lat}${endPos.lon}, startStop=${startStop.lat}${startStop.lon}, startStopId=${startStopId}[${[...stopIds].join(', ')}]`;
              console.log(msg);
            }else{              
              // Inherit marker for next trip
              nextTrip._inheritedMarker = vehicleMarkersWithActiveTrip[i];
              vehicleMarkersWithActiveTrip[i].setLatLng([startStop.lat, startStop.lon]); //move the marker to the start of the next trip
  
              // Remove path and marker from current arrays, but don't remove marker from map
              tripPaths.splice(i, 1);
              vehicleMarkersWithActiveTrip.splice(i, 1);    
              continue;
            }
          }
        }
        // No next trip: remove marker and path
        map.removeLayer(vehicleMarkersWithActiveTrip[i]);
        allVehicleMarkers = allVehicleMarkers.filter(m => m !== vehicleMarkersWithActiveTrip[i]); //remove from allVehicleMarkers        
        vehicleMarkersWithActiveTrip.splice(i, 1);
        tripPaths.splice(i, 1);
        continue;
      }
      // Animate marker as usual
      const idx = timedIndex(animationTime, path);
      if (idx >= 0 && idx < path.length - 1) {
        const a = path[idx], b = path[idx + 1];
        const frac = (animationTime - a.time) / (b.time - a.time);
        const lat = a.lat + (b.lat - a.lat) * frac;
        const lon = a.lon + (b.lon - a.lon) * frac;
        vehicleMarkersWithActiveTrip[i].setLatLng([lat, lon]);
      }
    }

    // Stop when no trips remain and all animated complete
    if (!remainingTrips.length && tripPaths.every(path => path[path.length - 1].time <= animationTime)) {
      stopAnimation();
    }

  }


function stopAnimation() {  

  // 1) Clear the running interval
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }

  // 2) Remove all vehicle markers from the map
  allVehicleMarkers.forEach(marker => {
    if (marker && map.hasLayer(marker)) {
      map.removeLayer(marker);
    }
  });
  allVehicleMarkers = [];
  updateTripPlot(animationTime); // Final update to trip plot

    // append the final data point to the 
  const nextHour = Math.ceil(animationTime / 3600);
  updateHeadwayPlotForHour(nextHour-1);

  // 3) Reset all trip/animation state
  tripPaths = [];
  remainingTrips = [];
  vehicleMarkersWithActiveTrip = [];

  // 4) Reset the clock
  animationTime = null;  
  document.getElementById('timeDisplay').textContent = '00:00:00';
  
  // 5) Reset pause button label
  const pauseButton = document.getElementById('pauseButton');
  if (pauseButton) pauseButton.textContent = '⏯️ Pause';
}


// === Helper: find segment index by time using binary search ===
function timedIndex(time, path) {
  let low = 0, high = path.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (path[mid].time < time) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

//pause function
function togglePauseResume(){
  const pauseButton = document.getElementById('pauseButton');
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
    console.log("Simulation paused.");
    pauseButton.textContent = '⏯️ Resume';
  }else{
    pauseButton.textContent = '⏯️ Pause';
      animationTimer = setInterval(() => {
        UpdateAnimationOnAnimationTimeChange();
    }, FRAME_INTERVAL_MS);
  }
}

//speed control
function changeAnimationSpeed(){
    speedMultiplier = parseFloat(document.getElementById('speedSelect').value);
}

function showProgressBar() {
  document.getElementById('progressBarContainer').style.display = 'block';
  setProgressBar(0);
   document.getElementById('uiBlockOverlay').style.display = 'block'; //when loading data, block UI interaction

}
function setProgressBar(percent) {
  document.getElementById('progressBar').style.width = percent + '%';
  document.getElementById('progressBarText').textContent = `Loading GTFS File: ${Math.round(percent)}%`;
}
function hideProgressBar() {
  document.getElementById('progressBarContainer').style.display = 'none';
  document.getElementById('uiBlockOverlay').style.display = 'none'; // unlock UI interaction
}

function showTransitScorePopup(msg) {
  const popup = document.getElementById('transitScorePopup');
  if (!popup) return;
  popup.textContent = msg;
  popup.classList.add('show');
  popup.style.display = 'block';
  setTimeout(() => {
    popup.classList.remove('show');
    setTimeout(() => { popup.style.display = 'none'; }, 400);
  }, 3000);
}

// === Run on Load ===
window.addEventListener('DOMContentLoaded', () => {
  loadGtfsFromWebZip();
  
  document.getElementById('routeTypeSelect');
  document.getElementById('serviceIdSelect');
  document.getElementById('playBtn').addEventListener('click', () => {
    stopAnimation(); // Stop any existing animation first
    initializeAnimation();
    startAnimation();
  });

  document.getElementById('uploadGtfsBtn').addEventListener('click', () => {
    document.getElementById('gtfsFileInput').click();
  });
  document.getElementById('pauseButton').addEventListener('click', togglePauseResume);
  document.getElementById('stopBtn').addEventListener('click', stopAnimation);
  document.getElementById('speedSelect').addEventListener('change', changeAnimationSpeed);

  document.getElementById('updateMapBtn').addEventListener('click', function() {
    // Use the same logic as at the start of simulation
    stopAnimation();
    plotFilteredStopsAndShapes(filteredTrips);
  });

  document.getElementById('gtfsFileInput').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
      loadGtfsFromUserUploadZip(file);
      document.getElementById('dataSourceText').textContent = file.name;
    }
  });  
  initTripPlot();
  setupVehKmPlot();
  setupTripsPerHourPlot();
  setupTransitScoreMapClickHandler();

  // Ribbon icon toggle logic (not mutually exclusive)
  document.querySelectorAll('.ribbon-icon').forEach(btn => {
    btn.addEventListener('click', function() {
      const canvasId = this.getAttribute('data-canvas');
      if (!canvasId) return;

      const canvas = document.getElementById(canvasId);
      const isActive = this.classList.contains('active');

      // Toggle active state and canvas visibility
      if (isActive) {
        this.classList.remove('active');
        if (canvas) canvas.style.display = 'none';
        this.blur(); 
      } else {
        this.classList.add('active');
        if (canvas) canvas.style.display = 'flex';
      }
    });
  });

  // Tab logic for graphs and stats
  document.querySelectorAll('.canvas-header').forEach(header => {
    header.querySelectorAll('.tab-btn').forEach(tabBtn => {
      tabBtn.addEventListener('click', function() {
        // Remove active from all tabs in this header
        header.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        // Hide all tab-contents in this canvas
        const canvas = header.parentElement;
        canvas.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
        // Activate this tab
        this.classList.add('active');
        const tabId = this.getAttribute('data-tab');
        canvas.querySelector(`#${tabId}`).classList.add('active');
      });
    });
  });

  document.getElementById('selectAllRouteType').onclick = function() {
    const sel = document.getElementById('routeTypeSelect');
    for (let i = 0; i < sel.options.length; i++) {
      sel.options[i].selected = true;
    }
    sel.dispatchEvent(new Event('change'));
  };

  document.getElementById('selectAllRouteName').onclick = function() {
    const sel = document.getElementById('routeShortNameSelect');
    for (let i = 0; i < sel.options.length; i++) {
      sel.options[i].selected = true;
    }
    sel.dispatchEvent(new Event('change'));
  };

  // Handle all close-canvas buttons
  document.querySelectorAll('.close-canvas-btn').forEach(btn => {
    btn.onclick = function() {
      // Find the parent floating-canvas
      let canvas = btn.closest('.floating-canvas');
      if (canvas) canvas.style.display = 'none';
      // Also deactivate the ribbon icon if needed
      const canvasId = canvas.id;
      document.querySelectorAll(`.ribbon-icon[data-canvas="${canvasId}"]`).forEach(icon => icon.classList.remove('active'));
    };
  });

  // open the first canvas by default
  document.querySelector('.ribbon-icon[data-canvas="animationCanvas"]').click();
  document.querySelector('.ribbon-icon[data-canvas="helpCanvas"]').click();

  // Make some of the canvas draggable
  ['graphsCanvas', 'statsCanvas', 'helpCanvas', 'animationCanvas'].forEach(canvasId => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const header = canvas.querySelector('.canvas-header');
    if (!header) return;

    header.style.cursor = 'move';
    let offsetX = 0, offsetY = 0, isDragging = false;

    header.addEventListener('mousedown', function(e) {
      isDragging = true;
      const rect = canvas.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      
      lastDraggedDepth = canvas.style.zIndex;
      canvas.style.zIndex = 3000;
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      canvas.style.left = (e.clientX - offsetX) + 'px';
      canvas.style.top = (e.clientY - offsetY) + 'px';
      canvas.style.right = 'auto';
      canvas.style.bottom = 'auto';
      canvas.style.position = 'fixed';
    });

    document.addEventListener('mouseup', function() {
      if (isDragging) {
        isDragging = false;
        document.body.style.userSelect = '';
        setTimeout(() => { canvas.style.zIndex = lastDraggedDepth; }, 200);
      }
    });
  });
  

  document.getElementById('aggregateStops').checked = true;
  document.getElementById('aggregateStops').addEventListener('change', function() {
    skipAggregatingStopThreshold = this.checked ? 200 : Infinity; 
    plotFilteredStopsAndShapes(filteredTrips);
  });
});