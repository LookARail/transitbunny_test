let gtfsWorker = null;

// === Global GTFS data ===
let stops = [];
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
let serviceDateFilterMode = false; // true if using service-date filter, but for nearly all GTFS feeds this is false

// === Precomputed maps ===
let tripStartTimeAndStopMap = {};   // 
let blockIdTripMap = {};
let stopTimesText = '';

// === Short‑name lookup by route_type ===
let shortAndLongNamesByType = {}; // 
let shortNameToServiceIds = {}; 

// === Animation Controls ===
const FRAME_INTERVAL_MS = 100;   // real ms per frame
const TIME_STEP_SEC    = 1;    // simulated seconds per frame
let speedMultiplier = 10;

let stopsById = new Map();           // stop_id -> {id,name,lat,lon}
let shapesById = {};                 // shape_id -> [ {lat,lon,sequence,shape_dist_traveled}, ... ]
let shapesRoute = {};              // shape_id -> corresponding
let shapeCumulativeDist = {};        // shape_id -> [cumulative distances]

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

let vehKmPendingPoints = {}; 

async function loadGtfsFromWebZip() {
  const url = 'gtfs.zip';
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    await LoadGTFSZipFile(buffer); 
  } catch (err) {
    console.error('Failed to load GTFS ZIP:', err);
  }
}

async function loadGtfsFromUserUploadZip(file) {
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const buffer = e.target.result;
      await LoadGTFSZipFile(buffer); 
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

    let rawZipBuffer = null;

    // detect type:
    if (zipFileInput instanceof File) {
      rawZipBuffer = await zipFileInput.arrayBuffer();
    } else if (zipFileInput instanceof ArrayBuffer) {
      rawZipBuffer = zipFileInput;
    } else if (zipFileInput instanceof Uint8Array) {
      rawZipBuffer = zipFileInput.buffer;
    } else {
      throw new Error('LoadGTFSZipFile: unsupported input type. Provide a File, ArrayBuffer, or Uint8Array.');
    }

    if (rawZipBuffer.byteLength && rawZipBuffer.byteLength > 1024 * 1024 * 1024) {
      console.warn('Raw zip is very large:', rawZipBuffer.byteLength);
    }

    const fileProgress = {};
    const weights = {};
    let lastOverall = 0;
    let worker = null;

    const results = await new Promise((resolve, reject) => {
      if (gtfsWorker) {
        gtfsWorker.terminate();
      }
      gtfsWorker = new Worker('gtfsWorker.js');
      worker = gtfsWorker;

      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;

        if (msg.type === 'files') {          
          const filesObj = msg.files || {};          
          let total = 0;
          Object.keys(filesObj).forEach(f => { total += filesObj[f] || 0; });
          if (total > 0) {
            Object.keys(filesObj).forEach(f => {
              weights[f] = (filesObj[f] || 0) / total;
              fileProgress[f] = 0;
            });
          } else {
            const keys = Object.keys(filesObj);
            const w = keys.length ? 1 / keys.length : 0;
            keys.forEach(f => { weights[f] = w; fileProgress[f] = 0; });
          }
          setProgressBar(8);
        } else if (msg.type === 'status') {        
          setProgressBar(Math.max(lastOverall, 8));
          console.log('[Worker status]', msg.message);
        } else if (msg.type === 'progress') {
          if (msg.file === 'filtered_stop_times') {
            setProgressBar(Math.round((msg.progress || 0) * 100), 'Reloading schedule for filtered trips...');           
            console.log(msg.file + ' progress:', msg.progress);
            return;
          }else{
            if (msg.file && weights[msg.file] !== undefined) {
              fileProgress[msg.file] = Math.max(0, Math.min(1, msg.progress || 0));
            } else if (msg.file) {            
              if (fileProgress[msg.file] === undefined) { fileProgress[msg.file] = Math.max(0, Math.min(1, msg.progress || 0)); weights[msg.file] = 0.0001; }
              else fileProgress[msg.file] = Math.max(fileProgress[msg.file], Math.max(0, Math.min(1, msg.progress || 0)));
            }
            
            let weighted = 0;
            let sumW = 0;
            Object.keys(weights).forEach(f => {
              const w = weights[f] || 0;
              weighted += w * (fileProgress[f] || 0);
              sumW += w;
            });
            const avg = sumW > 0 ? (weighted / sumW) : 0;
            
            let overall = 10 + Math.round(avg * 80);
            overall = Math.max(lastOverall, overall);
            lastOverall = overall;
            setProgressBar(overall);
          }
        } else if (msg.type === 'done') {
          resolve(msg.results);
        } else if (msg.type === 'error') {
          reject(new Error(msg.message || 'Worker error'));
        }
      
      };


      worker.onerror = (errEv) => {
        reject(errEv.error || new Error('Worker runtime error'));
      };

      if (!worker._requestDispatcherInstalled) {
        worker._requestDispatcherInstalled = true;
        worker._nextWorkerReqId = 1;
        worker._pendingRequests = new Map();
        worker.addEventListener('message', (ev) => {
          const msg = ev.data;
          if (!msg) return;
          const rid = msg.requestId || null;
          if (!rid) return;
          const ctx = worker._pendingRequests.get(rid);
          if (!ctx) return;
          clearTimeout(ctx.timer);
          worker._pendingRequests.delete(rid);
          if (msg.type === 'filteredStopTimes') ctx.resolve(msg.stopTimes);
          else if (msg.type === 'error') ctx.reject(new Error(msg.message || 'Worker error'));
          else ctx.reject(new Error('Unexpected worker reply'));
        });
      }

      // Send raw ZIP buffer to worker
      try {
        const uint8 = (rawZipBuffer instanceof Uint8Array) ? rawZipBuffer : new Uint8Array(rawZipBuffer);
        worker.postMessage({ rawZip: uint8 }, [uint8.buffer]);
      } catch (err) {
        reject(new Error('Failed to transfer raw ZIP to worker: ' + (err && err.message)));
      }
    });

    setProgressBar(95);

    stops = results.stops || [];
    if (results.stopsById && !(results.stopsById instanceof Map)) {
      stopsById = new Map(Object.entries(results.stopsById || {}).map(([k,v]) => [k, v]));
    } else {
      stopsById = results.stopsById || new Map();
    }
    
    shapesById = results.shapesById || {};
    shapeIdToDistance = results.shapeIdToDistance || {};
    routes = results.routes || [];
    trips = results.trips || [];        
    calendar = results.calendar || [];
    calendarDates = results.calendar_dates || [];

    buildServiceDateDict();
    initializeTripsRoutesShape(trips, routes);
    plotFilteredStopsAndShapes();

    setProgressBar(100);
    setTimeout(hideProgressBar, 500);
    updateServiceDateFilterUI();

  } catch (err) {
    hideProgressBar();
    console.error('Failed to process GTFS ZIP:', err);
  }
}


function requestFilteredStopTimesFromWorker(tripIds, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!gtfsWorker) return reject(new Error('No GTFS worker available'));
    const workerInst = gtfsWorker;
    if (!workerInst._requestDispatcherInstalled) {
      return reject(new Error('Worker request dispatcher not installed'));
    }
    const reqId = String(workerInst._nextWorkerReqId++);
    const timer = setTimeout(() => {
      workerInst._pendingRequests.delete(reqId);
      reject(new Error('Timeout waiting for filteredStopTimes'));
    }, timeoutMs);
    workerInst._pendingRequests.set(reqId, { resolve, reject, timer });

    workerInst.postMessage({
      type: 'extractStopTimesForTrips',
      requestId: reqId,
      tripIds: tripIds
    });
  });
}



function clearAllMapLayersAndMarkers() {
  if (stopsLayer && map.hasLayer(stopsLayer)) {
    map.removeLayer(stopsLayer);
    stopsLayer = null;
  }
  if (shapesLayer && map.hasLayer(shapesLayer)) {
    map.removeLayer(shapesLayer);
    shapesLayer = null;
  }
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
  routes = [];
  trips = [];
  stopTimes = [];
  // Clear filter & animation state
  routeTypes = [];
  serviceIds = [];
  filteredTrips = [];
  // Clear precomputed maps
  tripStartTimeAndStopMap = {};
  tripFirstStopsMap = {};
  // Clear short-name lookup
  shortAndLongNamesByType = {};
  shortNameToServiceIds = {};
  // Clear animation state
  animationTime = null;
  animationStartTime = null;
  currentTrip = null;
}



// --- Build Service-Date Dictionary ---
function buildServiceDateDict() {
  serviceDateDict = {};
  genericWeekdayDates = {};
  serviceDateFilterMode = false;

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
    serviceDateLabel.style.display = '';
    serviceIdLabel.style.display = 'none';
    serviceIdSelect.style.display = 'none';

    let options = [];
    for (const label in genericWeekdayDates) {
      options.push(`<option value="GENERIC:${label}">${label}</option>`);
    }
    const allDates = Object.keys(serviceDateDict).sort();
    for (const date of allDates) {
      const y = date.slice(0,4), m = date.slice(4,6), d = date.slice(6,8);
      options.push(`<option value="${date}">${y}-${m}-${d}</option>`);
    }
    serviceDateSelect.innerHTML = options.join('');
    
    serviceDateSelect.onchange = function(e) {
      const selected = Array.from(this.selectedOptions);
      if (selected.length > 2) {
        selected[selected.length - 1].selected = false;
        alert('You can select up to 2 service dates only.');
      }
      filterTrips();
    };
  } else {
    serviceDateLabel.style.display = 'none';
    serviceIdLabel.style.display = '';
    serviceIdSelect.style.display = '';
  }
}




function initializeTripsRoutesShape(tripsArr, routesArr) {
  shortAndLongNamesByType = {};

  const routeMap = new Map(routesArr.map(r=>[r.route_id,r]));
  routeTypes = [...new Set(routesArr.map(r => r.route_type))];
  serviceIds = [...new Set(tripsArr.map(t => t.service_id))];
  
  tripsArr.forEach(t => t.route = routeMap.get(t.route_id));

  if (shapesById) {
    Object.values(tripsArr).forEach(trip => {
      const route = routeMap.get(trip.route_id); 
      if (route)
      {
        shapesRoute[trip.shape_id] = route;      
      }
    });
  }

  routesArr.forEach(r => {
    if (!shortAndLongNamesByType[r.route_type]) shortAndLongNamesByType[r.route_type] = new Set();
    shortAndLongNamesByType[r.route_type].add(`${r.route_short_name}-${r.route_long_name}`);
  });

  shortNameToServiceIds = {}; 
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

  if (sdSel) {
    sdSel.onchange = filterTrips;
  }

  rtSel.dispatchEvent(new Event('change'));
}

let filteredTrips1 = [];
let filteredTrips2 = [];

async function filterTrips(useAllServiceDates = false) {
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

    if (selectedServiceIdsArr.length > 0 || useAllServiceDates) {
      filteredTrips1 = trips.filter(t =>
        types.includes(t.route.route_type) &&
        names.includes(`${t.route.route_short_name}-${t.route.route_long_name}`)
      );
      if(!useAllServiceDates){
        filteredTrips1 = filteredTrips1.filter(t =>selectedServiceIdsArr[0].has(t.service_id));
      }
    }
    if (selectedServiceIdsArr.length > 1 || useAllServiceDates) {
      filteredTrips2 = trips.filter(t =>
        types.includes(t.route.route_type) &&
        names.includes(`${t.route.route_short_name}-${t.route.route_long_name}`)        
      );
      if(!useAllServiceDates){
        filteredTrips2 = filteredTrips2.filter(t =>selectedServiceIdsArr[1].has(t.service_id));
      }
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

  
  const haveTrips = new Set(stopTimes.map(r => String(r.trip_id)));
  const missingTripIds = filteredTrips.filter(tid => !haveTrips.has(String(tid.trip_id)));

  if (missingTripIds.length > 0) {
    showProgressBar(); 
    setProgressBar(0, 'Loading stop times for filtered trips...');   
    const newStopTimes = await requestFilteredStopTimesFromWorker(missingTripIds.map(t => t.trip_id));              
    hideProgressBar();
    stopTimes = stopTimes.concat(newStopTimes);
    tripStartTimeAndStopMap = {}; //build tripStartTimemap   
    stopTimes.forEach(st => {
      if (st.stop_sequence == 1) {
        const depTimeStr = st.departure_time || st.arrival_time || null;
        if (depTimeStr) {
          const depTimeSec = timeToSeconds(depTimeStr);
          // Only set if not already set, or if this depTimeSec is earlier
          if (
            !tripStartTimeAndStopMap[st.trip_id] 
          ) {
            tripStartTimeAndStopMap[st.trip_id] = {
              departureTimeSec: depTimeSec,
              stop_id: st.stop_id
            };
          }
        }
      }
    });

  }
}

let skipAggregatingStopThreshold = 200;
function plotFilteredStopsAndShapes(tripsToShow) {
  if (stopsLayer && map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
  if (shapesLayer && map.hasLayer(shapesLayer)) map.removeLayer(shapesLayer);

  let stopsToPlot;
  let shapesToPlot = [];

  if (Array.isArray(tripsToShow) && tripsToShow.length > 0) {    
    
    const tripIdsToShow = new Set(tripsToShow.map(t => t.trip_id));    
    const usedStops = new Set(stopTimes.filter(st=> tripIdsToShow.has(st.trip_id)).map(st => st.stop_id));
    stopsToPlot = stops.filter(s => usedStops.has(s.id));
    
    const usedShapes = new Set();
    tripsToShow.forEach(t => {
      usedShapes.add(t.shape_id);
    });
    usedShapes.forEach(shape_id => {
      if (shapesById[shape_id]) shapesToPlot.push(...shapesById[shape_id]);
    });
  } else {
    stopsToPlot = stops;
    shapesToPlot = Object.values(shapesById).flat();
  }


  const totalStops = stopsToPlot.length;

  const basePixels = 60;        
  const refZoom = 14;         
  const clampMaxPx = 100;      
  const minMultiplier = 0.20;    
  const minCount = 200;      
  const maxCount = 3000;    

  function smoothstep(a, b, x) {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
  }

  const rawScale = smoothstep(minCount, maxCount, totalStops);
  const multiplier = minMultiplier + (1 - minMultiplier) * rawScale;

  stopsLayer = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: function (zoom) {
          const zoomScaledBase = basePixels * Math.pow(2, refZoom - zoom);
          const px = Math.max(6, Math.round(zoomScaledBase * multiplier));
          return Math.min(clampMaxPx, px);
        },
        chunkInterval: 200,
        chunkDelay: 40
      })
    : L.layerGroup();

     if (totalStops <= skipAggregatingStopThreshold) stopsLayer = L.layerGroup();

  for (const stop of stopsToPlot) {
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      color: 'red',
      fillColor: 'red',
      fillOpacity: 0.8
    }).bindTooltip(stop.name);
    stopsLayer.addLayer(marker);
  }

  shapesLayer = L.layerGroup();
  const shapesGrouped = {};
  for (const s of shapesToPlot) {
    if (!shapesGrouped[s.shape_id]) shapesGrouped[s.shape_id] = [];
    shapesGrouped[s.shape_id].push(s);
  }
  for (const shape_id in shapesGrouped) {
    const shapePoints = shapesGrouped[shape_id]
      .sort((a, b) => a.sequence - b.sequence)
      .map(s => [s.lat, s.lon]);
    const route = shapesRoute[shape_id] ? shapesRoute[shape_id] : null;
    if (route?.route_type === 3) {
      const color = route?.route_color ? `#${route.route_color}` : 'blue';
      const polyline = L.polyline(shapePoints, {
        shape_id: shape_id,
        color: color,
        weight: 2,
        interactive: true,
        touchTolerance: 80 
      });
      shapesLayer.addLayer(polyline);
    }
  }

  for (const shape_id in shapesGrouped) {
    const shapePoints = shapesGrouped[shape_id]
      .sort((a, b) => a.sequence - b.sequence)
      .map(s => [s.lat, s.lon]);
    const route = shapesRoute[shape_id] ? shapesRoute[shape_id] : null;
    if (route?.route_type !== 3) {
      const color = route?.route_color ? `#${route.route_color}` : 'blue';
      const polyline = L.polyline(shapePoints, {
        shape_id: shape_id,
        color: color,
        weight: 3,
        interactive: true,
        touchTolerance: 80 
      });
      shapesLayer.addLayer(polyline);
    }
  }

  stopsLayer.addTo(map);
  shapesLayer.addTo(map);

  const allCoords = [
    ...stopsToPlot.map(s => [s.lat, s.lon]),
    ...shapesToPlot.map(s => [s.lat, s.lon])
  ];
  if (allCoords.length) {
    const bounds = L.latLngBounds(allCoords);
    map.fitBounds(bounds);
  }

  setupShapeHoverInfo();
}


function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


function timeToSeconds(t) {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function interpolateTripPath(trip) {
  const tripStops = stopTimes.filter(st=>st.trip_id===trip.trip_id).sort((a,b)=>a.stop_sequence-b.stop_sequence);
  const shapePts = (shapesById[trip.shape_id] || []).slice().sort((a,b)=>a.sequence-b.sequence);
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

function initializeAnimation() {
  tripPlotData.labels = [];
  tripPlotData.datasets[0].data = [];
  tripPlotData.datasets[1].data = [];
  if (tripPlotChart) tripPlotChart.update();
  hourTicks = [];

  vehKmData = {};
  if (vehKmChart) {
    vehKmChart.data.datasets = [];
    vehKmChart.options.scales.x.min = undefined;
    vehKmChart.update();
  }

  window.tripIds1 = new Set(filteredTrips1.map(t => t.trip_id));
  window.tripIds2 = new Set(filteredTrips2.map(t => t.trip_id));

  if (!filteredTrips.length) { alert('No trips match filters'); return; }

  plotFilteredStopsAndShapes(filteredTrips);

  remainingTrips = filteredTrips.map(t => {
    t.startTime = tripStartTimeAndStopMap[t.trip_id]?.departureTimeSec ?? null;
    return t;
  }).filter(t => t.startTime != null);

  blockIdTripMap = {};
  remainingTrips.forEach(t => {
    if (!blockIdTripMap[t.block_id]) blockIdTripMap[t.block_id] = [];
    blockIdTripMap[t.block_id].push(t);
  });
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
    remainingTrips = remainingTrips.filter(t=>{
      if(t.startTime<=animationTime) {
        const path = interpolateTripPath(t);
        path.parentTrip = t;         
        if(path.length) {
          tripPaths.push(path);
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
            m.parentTrip = t;
            allVehicleMarkers.push(m);
            vehicleMarkersWithActiveTrip.push(m);
          }
        }
        return false;
      }
      return true;
    });

    for (let i = tripPaths.length - 1; i >= 0; i--) {
      const path = tripPaths[i];
      const endTime = path[path.length - 1].time;
      if (animationTime >= endTime) {
        const finishedTrip =path.parentTrip;

        if (finishedTrip){
            const shapePts = shapesById[finishedTrip.shape_id] || [];
            let tripDistanceKm = 0;
            if (shapePts.length > 1) {
              tripDistanceKm = shapeDistance(shapePts);
            }
            updateVehKmOnTripFinish(finishedTrip, tripDistanceKm, endTime);
        }

        if (finishedTrip && finishedTrip.block_id) {
          const tripsForBlock = blockIdTripMap[finishedTrip.block_id] || [];
          const nextTrip = finishedTrip.nextTrip;
            if (nextTrip && nextTrip.startTime > endTime && remainingTrips.includes(nextTrip)) {

            const endPos = path[path.length - 1];            
            const startStopId = tripStartTimeAndStopMap[nextTrip.trip_id].stop_id;
            const startStop = stops.find(s => s.id === startStopId);
                    
            const dist = calculateDistance(endPos.lat, endPos.lon, startStop.lat, startStop.lon);
            const layover = nextTrip.startTime - endTime;
            let msg = `Block ${finishedTrip.block_id} involving trips ${finishedTrip.trip_id} and ${nextTrip.trip_id}: Layover ${Math.round(layover / 60)} min, Distance ${Math.round(dist)} m`;

            if ((layover > 7200) || ((dist > 400 || layover < 7200) && (dist / layover > 5))) {
              msg += " ALERT: This is not considered a connection although the trips share the same block_id";
              msg += `DEBUG: endPos=${endPos.lat}${endPos.lon}, startStop=${startStop.lat}${startStop.lon}, startStopId=${startStopId}`;
              console.log(msg);
            }else{              
              nextTrip._inheritedMarker = vehicleMarkersWithActiveTrip[i];
              vehicleMarkersWithActiveTrip[i].setLatLng([startStop.lat, startStop.lon]); 
  
              tripPaths.splice(i, 1);
              vehicleMarkersWithActiveTrip.splice(i, 1);    
              continue;
            }
          }
        }
        map.removeLayer(vehicleMarkersWithActiveTrip[i]);
        allVehicleMarkers = allVehicleMarkers.filter(m => m !== vehicleMarkersWithActiveTrip[i]);     
        vehicleMarkersWithActiveTrip.splice(i, 1);
        tripPaths.splice(i, 1);
        continue;
      }
      const idx = timedIndex(animationTime, path);
      if (idx >= 0 && idx < path.length - 1) {
        const a = path[idx], b = path[idx + 1];
        const frac = (animationTime - a.time) / (b.time - a.time);
        const lat = a.lat + (b.lat - a.lat) * frac;
        const lon = a.lon + (b.lon - a.lon) * frac;
        vehicleMarkersWithActiveTrip[i].setLatLng([lat, lon]);
      }
    }

    if (!remainingTrips.length && tripPaths.every(path => path[path.length - 1].time <= animationTime)) {
      stopAnimation();
    }

  }


function stopAnimation() {  

  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }

  allVehicleMarkers.forEach(marker => {
    if (marker && map.hasLayer(marker)) {
      map.removeLayer(marker);
    }
  });
  allVehicleMarkers = [];
  updateTripPlot(animationTime); 

  const nextHour = Math.ceil(animationTime / 3600);
  updateHeadwayPlotForHour(nextHour-1);

  tripPaths = [];
  remainingTrips = [];
  vehicleMarkersWithActiveTrip = [];

  animationTime = null;  
  document.getElementById('timeDisplay').textContent = '00:00:00';
  
  const pauseButton = document.getElementById('pauseButton');
  if (pauseButton) pauseButton.textContent = '⏯️ Pause';
}

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

function togglePauseResume(){
  const pauseButton = document.getElementById('pauseButton');
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;    
    pauseButton.textContent = '⏯️ Resume';
  }else{
    pauseButton.textContent = '⏯️ Pause';
      animationTimer = setInterval(() => {
        UpdateAnimationOnAnimationTimeChange();
    }, FRAME_INTERVAL_MS);
  }
}

function changeAnimationSpeed(){
    speedMultiplier = parseFloat(document.getElementById('speedSelect').value);
}

function showProgressBar() {
  document.getElementById('progressBarContainer').style.display = 'block';  
  document.getElementById('uiBlockOverlay').style.display = 'block';
}
function setProgressBar(percent, mainText) {
  if (!mainText){
    mainText = 'Loading GTFS File';
  }
  document.getElementById('progressBar').style.width = percent + '%';
  document.getElementById('progressBarText').textContent = `${mainText}: ${Math.round(percent)}%`;
}
function hideProgressBar() {
  document.getElementById('progressBarContainer').style.display = 'none';
  document.getElementById('uiBlockOverlay').style.display = 'none'; 
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

function updateLegendFontSizeForMobile() {
  const isMobile = window.innerWidth <= 900;
  const titleFontSize = isMobile ? 9 : 16; 
  const legendFontSize = isMobile ? 9 : 14;

  if (tripPlotChart) {
    tripPlotChart.options.plugins.size = legendFontSize;
    tripPlotChart.options.plugins.title.font.size = titleFontSize;
    tripPlotChart.update();
  }
  if (vehKmChart) {
    vehKmChart.options.plugins.legend.labels.font.size = legendFontSize;
    vehKmChart.options.plugins.title.font.size = titleFontSize;
    vehKmChart.update();
  }
  if (tripsPerHourChart) {
    tripsPerHourChart.options.plugins.legend.labels.font.size = legendFontSize;
    tripsPerHourChart.options.plugins.title.font.size = titleFontSize;
    tripsPerHourChart.update();    
  }
}


window.addEventListener('resize', updateLegendFontSizeForMobile);

// === Run on Load ===
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('uiBlockOverlay').style.display = 'block'; //when loading for the first time, block UI interaction
  loadGtfsFromWebZip();
  
  document.getElementById('routeTypeSelect');
  document.getElementById('serviceIdSelect');
  document.getElementById('playBtn').addEventListener('click', () => {
    stopAnimation(); 
    initializeAnimation();
    startAnimation();
  });

  document.getElementById('uploadGtfsBtn').addEventListener('click', () => {
    document.getElementById('gtfsFileInput').click();
  });
  document.getElementById('pauseButton').addEventListener('click', togglePauseResume);
  document.getElementById('stopBtn').addEventListener('click', stopAnimation);
  document.getElementById('speedSelect').addEventListener('change', changeAnimationSpeed);

  document.getElementById('updateMapBtn').addEventListener('click', async function() {
    stopAnimation();
    await filterTrips(true);     
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
  updateLegendFontSizeForMobile();
  setupTransitScoreMapClickHandler();

  document.querySelectorAll('.ribbon-icon').forEach(btn => {
    btn.addEventListener('click', function() {
      const canvasId = this.getAttribute('data-canvas');
      if (!canvasId) return;

      const canvas = document.getElementById(canvasId);
      const isActive = this.classList.contains('active');

      if (isActive) {
        this.classList.remove('active');
        if (canvas) canvas.style.display = 'none';
        this.blur(); 
      } else {
        this.classList.add('active');
        if (canvas) canvas.style.display = 'flex';
      }

      if (window.innerWidth <= 900) {
        const exclusiveCanvases = ['graphsCanvas', 'statsCanvas', 'transitScoreCanvas'];
          if(exclusiveCanvases.includes(canvasId)) {
          exclusiveCanvases.forEach(id => {
            if (id !== canvasId) {
              const otherCanvas = document.getElementById(id);
              if (otherCanvas && otherCanvas.style.display !== 'none') {
                otherCanvas.style.display = 'none';
                document.querySelectorAll(`.ribbon-icon[data-canvas="${id}"]`).forEach(icon => icon.classList.remove('active'));
              }
            }
          });
        }
      }

    });
  });

  document.querySelectorAll('.canvas-header').forEach(header => {
    header.querySelectorAll('.tab-btn').forEach(tabBtn => {
      tabBtn.addEventListener('click', function() {
        header.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        const canvas = header.parentElement;
        canvas.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
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

  document.querySelectorAll('.close-canvas-btn').forEach(btn => {
    btn.onclick = function() {
      let canvas = btn.closest('.floating-canvas');
      if (canvas) canvas.style.display = 'none';
      const canvasId = canvas.id;
      document.querySelectorAll(`.ribbon-icon[data-canvas="${canvasId}"]`).forEach(icon => icon.classList.remove('active'));
    };
  });

  if (window.innerWidth > 900) {
    document.querySelector('.ribbon-icon[data-canvas="animationCanvas"]').click();
  }
  document.querySelector('.ribbon-icon[data-canvas="helpCanvas"]').click();

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

  map.createPane('highlightPane');
  map.getPane('highlightPane').style.zIndex = 399;
});