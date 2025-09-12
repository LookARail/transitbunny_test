
let tripStopsMap_analysis = {};
let stopIdToName = {};

function generateRouteStatsTable(filteredTrips, shapes, stops, stopTimes, routes) {
  // Map shape_id to its shape points
  const shapesById = {};
  shapes.forEach(s => {
    if (!shapesById[s.shape_id]) shapesById[s.shape_id] = [];
    shapesById[s.shape_id].push(s);
  });

  RecomputeMap();

  // Map route_id to route_name
  const routeNames = {};
  routes.forEach(r => {
    routeNames[r.route_id] = r.route_long_name || r.route_short_name || r.route_id;
  });

  // Group trips by route and shape_id
  const stats = {};
  filteredTrips.forEach(trip => {
    const routeName = routeNames[trip.route_id];
    if (!stats[routeName]) stats[routeName] = {};
    if (!stats[routeName][trip.shape_id]) stats[routeName][trip.shape_id] = [];
    stats[routeName][trip.shape_id].push(trip);
  });

  // Build table rows
  const rows = [];
  Object.entries(stats).forEach(([routeName, shapesObj]) => {
    Object.entries(shapesObj).forEach(([shape_id, tripsArr]) => {
      //console.log(`ShapeID ${shape_id}`);

      const shapePts = shapesById[shape_id] || [];
      const distance = shapePts.length > 1 ? Number(shapeDistance(shapePts).toFixed(3)) : 0;
      const [firstStation, lastStation] = getFirstLastStations(tripsArr[0]);
      const travelTimes = getTravelTimes(tripsArr);
      const shortest = travelTimes.length ? Math.round(Math.min(...travelTimes) / 60 * 10) / 10 : '';
      const longest = travelTimes.length ? Math.round(Math.max(...travelTimes) / 60 * 10) / 10 : '';
      const average = travelTimes.length  ? Math.round((travelTimes.reduce((a, b) => a + b, 0) / travelTimes.length) / 60 * 10) / 10  : '';
      const tripCount = tripsArr.length;

      rows.push({
        route_name: routeName,
        shape_id,
        first_station: firstStation,
        last_station: lastStation,
        distance,
        trip_count: tripCount,
        shortest,
        average,
        longest,
      });
    });
  });

  // Render table to a canvas or HTML table
  renderStatsTable(rows);
}

// Store generated rows for download
let lastStatsRows = [];

// Example rendering as HTML table (you can adapt for canvas)
function renderStatsTable(rows) {
  lastStatsRows = rows; // Save for download

  const container = document.getElementById('routeStatsTable');
  let html = `<table>
    <thead>
      <tr>
        <th>Route Name</th><th>Shape ID</th><th>First Station</th><th>Last Station</th>
        <th>Distance (km)</th><th>Trip Count</th><th>Shortest (min)</th><th>Average (min)</th><th>Longest (min)</th>
      </tr>
    </thead>
    <tbody>`;
  rows.forEach(row => {
    html += `<tr>
      <td>${row.route_name}</td>
      <td>${row.shape_id}</td>
      <td>${row.first_station}</td>
      <td>${row.last_station}</td>
      <td>${row.distance}</td>
      <td>${row.trip_count}</td>
      <td>${row.shortest}</td>
      <td>${row.average}</td>
      <td>${row.longest}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;
}

function downloadStatsCSV(rows) {
  if (!rows || !rows.length) return;
  const headers = [
    "Route Name", "Shape ID", "First Station", "Last Station",
    "Distance (km)",  "Trip Count","Shortest (min)", "Average (min)", "Longest (min)"
  ];
  const csvRows = [
    headers.join(","),
    ...rows.map(row =>
      [
        row.route_name,
        row.shape_id,
        `"${row.first_station.replace(/"/g, '""')}"`,
        `"${row.last_station.replace(/"/g, '""')}"`,
        row.distance,
        row.trip_count,
        row.shortest,
        row.average,
        row.longest
      ].join(",")
    )
  ];
  const csvContent = csvRows.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "route_statistics.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Utility functions (reuse from main.js or import)
function timeToSeconds(t) {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}


function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


//#region Compare Services
function populateCompareServiceDateFilters() {
  const sel1 = document.getElementById('compareServiceDate1');
  const sel2 = document.getElementById('compareServiceDate2');
  if (!sel1 || !sel2) return;

  // Build options (same as updateServiceDateFilterUI, but single-select)
  let options = [];
  for (const label in genericWeekdayDates) {
    options.push(`<option value="GENERIC:${label}">${label}</option>`);
  }
  const allDates = Object.keys(serviceDateDict).sort();
  for (const date of allDates) {
    const y = date.slice(0,4), m = date.slice(4,6), d = date.slice(6,8);
    options.push(`<option value="${date}">${y}-${m}-${d}</option>`);
  }
  sel1.innerHTML = options.join('');
  sel2.innerHTML = options.join('');
}

// --- Compare Service-Dates Button Handler ---
function setupCompareServiceDatesFeature() {
  // Populate filters on load and after GTFS load
  if (serviceDateFilterMode) populateCompareServiceDateFilters();

  // Re-populate after GTFS load or calendar change
  const origUpdateServiceDateFilterUI = updateServiceDateFilterUI;
  updateServiceDateFilterUI = function() {
    origUpdateServiceDateFilterUI();
    if (serviceDateFilterMode) populateCompareServiceDateFilters();
  };

  document.getElementById('compareServiceDatesBtn')?.addEventListener('click', function() {
    const sel1 = document.getElementById('compareServiceDate1');
    const sel2 = document.getElementById('compareServiceDate2');
    if (!sel1 || !sel2) return;
    const val1 = sel1.value, val2 = sel2.value;
    if (!val1 || !val2) {
      alert('Please select both service-dates.');
      return;
    }
    // Get current route type and route name filter selections
    const types = Array.from(document.getElementById('routeTypeSelect').selectedOptions).map(o => o.value);
    const names = Array.from(document.getElementById('routeShortNameSelect').selectedOptions).map(o => o.value);

    RecomputeMap();

    // Helper: get all service_ids for a service-date value
    function getServiceIdsFor(val) {
      let sids = new Set();
      if (val.startsWith('GENERIC:')) {
        const label = val.slice(8);
        (genericWeekdayDates[label] || []).forEach(date => {
          (serviceDateDict[date] || []).forEach(sid => sids.add(sid));
        });
      } else {
        (serviceDateDict[val] || []).forEach(sid => sids.add(sid));
      }
      return sids;
    }
    const sids1 = getServiceIdsFor(val1);
    const sids2 = getServiceIdsFor(val2);

    // Filter trips for each service-date, route type, and route name
    function tripsFor(sids) {
      return trips.filter(t =>
        types.includes(t.route.route_type) &&
        names.includes(`${t.route.route_short_name}-${t.route.route_long_name}`) &&
        sids.has(t.service_id)
      );
    }
    const trips1 = tripsFor(sids1);
    const trips2 = tripsFor(sids2);

    // Group trips by route_id
    function groupByRoute(tripArr) {
      const map = {};
      tripArr.forEach(t => {
        if (!map[t.route_id]) map[t.route_id] = [];
        map[t.route_id].push(t);
      });
      return map;
    }
    const byRoute1 = groupByRoute(trips1);
    const byRoute2 = groupByRoute(trips2);

    // Union of all route_ids in either set
    const allRouteIds = new Set([...Object.keys(byRoute1), ...Object.keys(byRoute2)]);

    // Precompute shapesById for fast lookup
    const shapesById = {};
    shapes.forEach(s => {
      if (!shapesById[s.shape_id]) shapesById[s.shape_id] = [];
      shapesById[s.shape_id].push(s);
    });

    function computeStats(tripArr) {
      let nTrips = tripArr.length;
      // Group trips by shape_id
      const tripsByShape = {};
      tripArr.forEach(t => {
        if (!tripsByShape[t.shape_id]) tripsByShape[t.shape_id] = [];
        tripsByShape[t.shape_id].push(t);
      });

      // Vehicle-KM: sum shape distance * #trips for each shape_id
      let totalKm = 0;
      for (const shape_id in tripsByShape) {
        const shapePts = shapesById[shape_id] || [];
        const dist = shapePts.length > 1 ? shapeDistance(shapePts) : 0;
        totalKm += dist * tripsByShape[shape_id].length;
      }

      // Average Trip Time: use getTravelTimes helper
      const travelTimes = getTravelTimes(tripArr);
      const avgTripTime = travelTimes.length
        ? (travelTimes.reduce((a, b) => a + b, 0) / travelTimes.length) / 60
        : '';

      return {
        nTrips,
        totalKm: totalKm ? totalKm.toFixed(2) : '',
        avgTripTime: avgTripTime ? avgTripTime.toFixed(1) : ''
      };
    }

    // Build table rows
    let rows = [];
    for (const route_id of allRouteIds) {
      const t1 = byRoute1[route_id] || [];
      const t2 = byRoute2[route_id] || [];
      // Route info
      let route = routes.find(r => r.route_id === route_id);
      let routeName = route ? `${route.route_short_name} - ${route.route_long_name}` : '';
      let stats1 = t1.length ? computeStats(t1) : { nTrips:'', totalKm:'', avgTripTime:'' };
      let stats2 = t2.length ? computeStats(t2) : { nTrips:'', totalKm:'', avgTripTime:'' };
      
      // Log travel times for debugging
      if (t1.length) {
        const travelTimes1 = t1.map(trip => {
          const tripStops = tripStopsMap_analysis[trip.trip_id] || [];
          if (tripStops.length < 2) return { trip_id: trip.trip_id, travelTimeMin: null };
          const start = timeToSeconds(tripStops[0].departure_time || tripStops[0].arrival_time);
          const end = timeToSeconds(tripStops[tripStops.length - 1].arrival_time || tripStops[tripStops.length - 1].departure_time);
          return { trip_id: trip.trip_id, travelTimeMin: ((end - start) / 60).toFixed(1) };
        });
      }
      if (t2.length) {
        const travelTimes2 = t2.map(trip => {
          const tripStops = tripStopsMap_analysis[trip.trip_id] || [];
          if (tripStops.length < 2) return { trip_id: trip.trip_id, travelTimeMin: null };
          const start = timeToSeconds(tripStops[0].departure_time || tripStops[0].arrival_time);
          const end = timeToSeconds(tripStops[tripStops.length - 1].arrival_time || tripStops[tripStops.length - 1].departure_time);
          return { trip_id: trip.trip_id, travelTimeMin: ((end - start) / 60).toFixed(1) };
        });
      }
      
      rows.push([
        routeName,
        route_id,
        stats1.nTrips, stats1.totalKm, stats1.avgTripTime,
        stats2.nTrips, stats2.totalKm, stats2.avgTripTime
      ]);
    }

    // Sort: base on routeName, then route_id
    rows.sort((a,b) => (a[0]||'').localeCompare(b[0]||'') || (a[1]||'').localeCompare(b[1]||''));

    // Table header
    const th = `
      <tr>
        <th>Route Name</th>
        <th>Route ID</th>
        <th># Trips<br>(${sel1.options[sel1.selectedIndex].text})</th>
        <th>Vehicle-KM<br>(${sel1.options[sel1.selectedIndex].text})</th>
        <th>Avg Trip Time (min)<br>(${sel1.options[sel1.selectedIndex].text})</th>
        <th># Trips<br>(${sel2.options[sel2.selectedIndex].text})</th>
        <th>Vehicle-KM<br>(${sel2.options[sel2.selectedIndex].text})</th>
        <th>Avg Trip Time (min)<br>(${sel2.options[sel2.selectedIndex].text})</th>
      </tr>
    `;
    const html = `<table style="width:100%; font-size:0.95em;">
      <thead>${th}</thead>
      <tbody>
        ${rows.map(r => `<tr>${r.map(cell => `<td>${cell||''}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>`;
    document.getElementById('compareServiceDatesTable').innerHTML = html;
  });
}


//#region Helper
// Helper: calculate shape distance
function shapeDistance(shapePts) {
  //Sort by shape_pt_sequence
  shapePts.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);

  // Check for shape_dist_traveled values
  const traveledValues = shapePts
      .map(pt => pt.shape_dist_traveled)
      .filter(val => val !== undefined && val !== null);

  // Only use shape_dist_traveled if there are non-zero values
  const nonZeroTraveled = traveledValues.filter(val => val > 0);

  if (nonZeroTraveled.length > 0) {
      //If available, return the maximum value
      return Math.max(...nonZeroTraveled);
  } else {
      //Otherwise, calculate manually
      let dist = 0;
      for (let i = 1; i < shapePts.length; i++) {
      dist += 0.001 * calculateDistance(
          shapePts[i - 1].lat, shapePts[i - 1].lon,
          shapePts[i].lat, shapePts[i].lon
      ); // Convert to kilometers
      }
      return dist;
  }
}

  // Helper: get travel times for all trips with shape_id
  function getTravelTimes(trips) {
    //console.log(`Computing Travel Time`);

    return trips.map(trip => {
        const tripStops = tripStopsMap_analysis[trip.trip_id] || [];
        if (tripStops.length < 2) return null;
        const start = timeToSeconds(tripStops[0].departure_time || tripStops[0].arrival_time);
        const end = timeToSeconds(tripStops[tripStops.length - 1].arrival_time || tripStops[tripStops.length - 1].departure_time);
        return end - start;
    }).filter(t => t !== null);
  }

  // Helper: get first/last station for a trip
  function getFirstLastStations(trip) {
    //console.log(`For trip${trip.trip_id}. Trying to find first and last stations.`);

    const tripStops = stopTimes.filter(st => st.trip_id === trip.trip_id)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
    const firstStopName = stopIdToName[tripStops[0].stop_id] || '';
    const lastStopName = stopIdToName[tripStops[tripStops.length - 1].stop_id] || '';
    return [firstStopName, lastStopName];
  }

function RecomputeMap(){
  // Precompute stopIdToName map  
  stopIdToName = {};
  stops.forEach(s => { stopIdToName[s.id] = s.name; });

   // Precompute stopIdToName map
  tripStopsMap_analysis = {};
  stopTimes.forEach(st => {
  if (!tripStopsMap_analysis[st.trip_id]) tripStopsMap_analysis[st.trip_id] = [];
    tripStopsMap_analysis[st.trip_id].push(st);
  });
  // Sort each trip's stops by stop_sequence
  Object.values(tripStopsMap_analysis).forEach(stopsArr => {
    stopsArr.sort((a, b) => a.stop_sequence - b.stop_sequence);
  });
}

//#endregion

// === Run on Load ===
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('GenerateStat').addEventListener('click', () => {
    console.log('Generating route statistics...');
    generateRouteStatsTable(filteredTrips, shapes, stops, stopTimes, routes);    
  });

  document.getElementById('DownloadStat').addEventListener('click', () => {
    if (!lastStatsRows || lastStatsRows.length === 0) {
      alert("No statistics available to download. Please generate statistics first.");
      return;
    }
    downloadStatsCSV(lastStatsRows);
  });

  setupCompareServiceDatesFeature();

});