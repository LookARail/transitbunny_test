
//#region Trip Plotting
let tripPlotChart = null;
let hourTicks = []; // Track which hour ticks have been added

let tripPlotData = {
  labels: [],
  datasets: [
    {
      label: 'Service Date 1',
      data: [],
      fill: true,
      backgroundColor: 'rgba(0,120,215,0.2)',
      borderColor: '#0078d7',
      tension: 0.2
    },
    {
      label: 'Service Date 2',
      data: [],
      fill: true,
      backgroundColor: 'rgba(255,120,0,0.2)',
      borderColor: '#ff7f00',
      tension: 0.2
    }
  ]
};

function initTripPlot() {
  const ctx = document.getElementById('tripPlot').getContext('2d');
  tripPlotChart = new Chart(ctx, {
    type: 'line',
    data: tripPlotData,
    options: {      
      responsive: true,
      animation: false,
      scales: {
        x: {
          type: 'linear',           
          title: { display: true, text: 'Time (HH:MM)' },
          ticks: {
            autoSkip: false,
            stepSize: 3600, // one hour in seconds
            callback: function(value) {
              // Format seconds as HH:MM
              const h = Math.floor(value / 3600).toString().padStart(2, '0');
              return `${h}:00`;
            }
          }
        },
        y: {
          title: { display: true, text: 'Number of Active Vehicles' },
          beginAtZero: true,
          ticks: {
            stepSize: 1,
            callback: function(value) {
              return Math.round(value);
            }
          }
        }
      },
      plugins: {
        legend: { display: true, position: 'bottom' },
        title: { text: 'Number of Vehicles', display: true, font: { size: 14 } },
        tooltip: {
        callbacks: {
          title: function(context) {
            // context[0].parsed.x is the x value in seconds
            const value = context[0].parsed.x;
            const h = Math.floor(value / 3600).toString().padStart(2, '0');
            const m = Math.floor((value % 3600) / 60).toString().padStart(2, '0');
            return `${h}:${m}`;
          }
        }
      }
      }
    }
  });


  tripPlotChart.update();
}

function updateTripPlot(currentTime) {
  let count1 = 0, count2 = 0;
  for (const m of allVehicleMarkers) {
    if (m.parentTrip && window.tripIds1 && window.tripIds1.has(m.parentTrip.trip_id)) count1++;
    if (m.parentTrip && window.tripIds2 && window.tripIds2.has(m.parentTrip.trip_id)) count2++;
  }

  // Use dataset[0].data last x as lastTime (seconds)
  const ds0 = tripPlotChart.data.datasets[0].data;
  const lastTime = ds0 && ds0.length > 0 ? ds0[ds0.length - 1].x : null;

  // If this is the first-ever point, add a zero point at (currentTime - animation step)
  if (lastTime === null) {
    const zeroTime = currentTime - (TIME_STEP_SEC * speedMultiplier);
    tripPlotChart.data.datasets[0].data.push({ x: zeroTime, y: 0 });
    tripPlotChart.data.datasets[1].data.push({ x: zeroTime, y: 0 });
  }

  if (lastTime === null || currentTime - lastTime >= 60 || (count1 === 0 && count2 === 0)) {
    // push numeric points (seconds)
    tripPlotChart.data.datasets[0].data.push({ x: currentTime, y: count1 });
    // always push for dataset1 as well so x positions line up
    if (tripPlotChart.data.datasets[1]) {
      tripPlotChart.data.datasets[1].data.push({ x: currentTime, y: count2 });
    }
    
    // legend handling
    const sdSel = document.getElementById('serviceDateSelect');
    const selectedLabels = Array.from(sdSel.selectedOptions).map(o => o.text);
    tripPlotChart.data.datasets[0].label = selectedLabels[0] || "Service Date 1";
    if (selectedLabels.length > 1) {
      tripPlotChart.data.datasets[1].label = selectedLabels[1];
      tripPlotChart.data.datasets[1].hidden = false;
    } else {
      tripPlotChart.data.datasets[1].label = "";
      tripPlotChart.data.datasets[1].hidden = true;
    }
    const hasData2 = selectedLabels.length > 1;
    tripPlotChart.data.datasets[1].hidden = !hasData2;
    tripPlotChart.options.plugins.legend.display = hasData2;

    tripPlotChart.update();
  }
}




// --- Vehicle-Kilometer Plot Setup ---
const vehKmColors = [
  "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00",
  "#ffff33", "#a65628", "#f781bf", "#999999", "#1b9e77"
];
let vehKmChart;
let vehKmData = []; // { route_id: { label, color, data: [{x, y}], total } }
let vehKmTime = 0;  // Current simulation time in seconds

function setupVehKmPlot() {
  const ctx = document.getElementById('vehKmPlot').getContext('2d');
  vehKmChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: []
    },
    options: {
      responsive: true,      
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#222', font: { weight: 'bold' } }
        },
        title: {
          display: true,
          text: 'Cumulative Vehicle-Kilometers by Route',
          font: { size: 14 }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Animation Time (s)' },
          min: undefined, // will be set dynamically
          ticks: {
            // Only show ticks at whole hours
            stepSize: 3600,
            callback: function(value) {
              // Only show label if value is a whole hour
              if (value % 3600 === 0) {
                const h = Math.floor(value / 3600).toString().padStart(2, '0');
                return `${h}:00`;
              }
              return '';
            }
          }
        },
        y: {
          title: { display: true, text: 'Cumulative Vehicle-Kilometers' }
        }
      }
    }
  });
}

function updateVehKmOnTripFinish(trip, tripDistanceKm, simTime) {
  // Only track top 10 routes by cumulative km
  const routeId = trip.route_id;
  const sdSel = document.getElementById('serviceDateSelect');
  const selectedLabels = Array.from(sdSel.selectedOptions).map(o => o.text);

  if (window.tripIds1 && window.tripIds1.has(trip.trip_id)){
    const key = `${trip.route_id}__${selectedLabels[0]}`;
    if (!vehKmData[key]) {
      const colorIdx = Object.keys(vehKmData).length % vehKmColors.length;
      vehKmData[key] = {
        label: `${getRouteLabel(routeId)}  (${selectedLabels[0]})`,
        color: vehKmColors[colorIdx],
        data: [],
        total: 0
      };
    }

    // Buffer the tripDistanceKm and simTime
    if (!vehKmPendingPoints[key]) vehKmPendingPoints[key] = [];
    vehKmPendingPoints[key].push({ x: simTime, distance: tripDistanceKm });
  } 
  if (window.tripIds2 && window.tripIds2.has(trip.trip_id)){
    const key = `${trip.route_id}__${selectedLabels[1]}`;
    if (!vehKmData[key]) {
      const colorIdx = Object.keys(vehKmData).length % vehKmColors.length;
      vehKmData[key] = {
        label: `${getRouteLabel(routeId)}  (${selectedLabels[1]})`,
        color: vehKmColors[colorIdx],
        data: [],
        total: 0
      };
    }

    // Buffer the tripDistanceKm and simTime
    if (!vehKmPendingPoints[key]) vehKmPendingPoints[key] = [];
    vehKmPendingPoints[key].push({ x: simTime, distance: tripDistanceKm });
  } 
 }

function flushVehKmPendingPoints() {
  Object.entries(vehKmPendingPoints).forEach(([key, points]) => {
    // Sort points by x (time)
    points.sort((a, b) => a.x - b.x);
    let routeObj = vehKmData[key];
    if (!routeObj) return;
    // Start from the last total
    let total = routeObj.data.length > 0 ? routeObj.data[routeObj.data.length - 1].y : 0;
    points.forEach(pt => {
      total += pt.distance;
      routeObj.data.push({ x: pt.x, y: total });
    });
    routeObj.total = total;
  });
  vehKmPendingPoints = {};

  // Keep only top 10 by total
  let sorted = Object.entries(vehKmData)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10);

  vehKmChart.data.datasets = sorted.map(([routeId, obj]) => ({
    label: obj.label,
    data: obj.data,
    borderColor: obj.color,
    backgroundColor: obj.color,
    fill: false,
    tension: 0.1
  }));

  // Find the minimum x value among all datasets
  let minX = Infinity;
  vehKmChart.data.datasets.forEach(ds => {
    if (ds.data.length > 0) {
      const firstX = ds.data[0].x;
      if (firstX < minX) minX = firstX;
    }
  });
  if (minX !== Infinity) {
    vehKmChart.options.scales.x.min = Math.floor(minX / 3600) * 3600;
  }
  vehKmChart.update();
}

// Helper to get route label (short or long name)
function getRouteLabel(routeId) {
  const route = routes.find(r => r.route_id === routeId);
  if (!route) return routeId;
  // Show "short name - long name" (like in filters)
  if (route.route_short_name && route.route_long_name) {
    return `${route.route_short_name} - ${route.route_long_name}`;
  }
  return route.route_short_name || route.route_long_name || route.route_id;
}


// --- Trips Per Hour Plot Setup ---
let tripsPerHourChart;
let tripsPerHourColors = vehKmColors; // Reuse color palette
let lastTripsPerHourUpdateHour = null;
let tripsPerHourSeries = {}; // { route_id_serviceDate: [{x: hour, y: count}, ...] }
let hasOneDirectionalHourInPlot = false;
let mostCommonShapeIdByRouteDir = {}; // { route_id: { direction_id: shape_id } }
let mostCommonShapeDistByRouteDir = {}; // { route_id: { direction_id: distance } }

function buildMostCommonShapeIdByRouteDir() {
  mostCommonShapeIdByRouteDir = {};
  mostCommonShapeDistByRouteDir = {};

  // Count shape_id usage for each route/direction
  const countMap = {}; // { route_id: { direction_id: { shape_id: count } } }
  trips.forEach(trip => {
    const routeId = trip.route_id;
    const dir = trip.direction_id ?? 'none';
    const shapeId = trip.shape_id;
    if (!countMap[routeId]) countMap[routeId] = {};
    if (!countMap[routeId][dir]) countMap[routeId][dir] = {};
    countMap[routeId][dir][shapeId] = (countMap[routeId][dir][shapeId] || 0) + 1;
  });

  // Find the most common shape_id for each route/direction
  Object.entries(countMap).forEach(([routeId, dirMap]) => {
    mostCommonShapeIdByRouteDir[routeId] = {};
    mostCommonShapeDistByRouteDir[routeId] = {};
    Object.entries(dirMap).forEach(([dir, shapeCounts]) => {
      let maxCount = -1, mostCommonShapeId = null;
      Object.entries(shapeCounts).forEach(([shapeId, count]) => {
        if (count > maxCount) {
          maxCount = count;
          mostCommonShapeId = shapeId;
        }
      });
      mostCommonShapeIdByRouteDir[routeId][dir] = mostCommonShapeId;
      mostCommonShapeDistByRouteDir[routeId][dir] = shapeIdToDistance[mostCommonShapeId] || 1;
    });
  });
}

function setupTripsPerHourPlot() {
  lastTripsPerHourUpdateHour = null;
  tripsPerHourSeries = {};

  const ctx = document.getElementById('tripsPerHourPlot').getContext('2d');
  tripsPerHourChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: []
    },
    options: {
      responsive: true,      
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#222', font: { weight: 'bold' } }
        },
        title: {
          display: true,
          text: 'Estimated Headway (mm:ss) by Route',
          font: { size: 14 }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Hour of Day' },
          ticks: {
            stepSize: 1,
            callback: function(value) {
              return `${value}:00`;
            }
          }
        },
        y: {
          title: { display: true, text: 'Estimated Headway (mm:ss)' },
          beginAtZero: true,
          ticks: {
            stepSize: 1,
            callback: function(value) {
                if (value == null || !isFinite(value)) return '';
                const mins = Math.floor(value);
                const secs = Math.round((value - mins) * 60);
                return `${mins}:${secs.toString().padStart(2, '0')}`;
              }
          }
        }
      }
    }
  });
}

function updateHeadwayPlotForHour(hour) {
  // Check if direction_id is present in any trip
  const hasDirectionId = trips.some(t => t.direction_id !== undefined && t.direction_id !== '');

  const sdSel = document.getElementById('serviceDateSelect');
  const selectedLabels = Array.from(sdSel.selectedOptions).map(o => o.text);
  let serviceDateLabel = null;

  // { route_id: { direction_id: [trip_id, ...] } }
  const hourTrips = {};
  filteredTrips.forEach(trip => {
    const routeId = trip.route_id;
    const startTime = tripStartTimeAndStopMap[trip.trip_id]?.departureTimeSec ?? null;
    if (startTime == null) return;
    const tripHour = Math.floor(startTime / 3600);
    if (tripHour !== hour) return;

    const dir = hasDirectionId ? (trip.direction_id ?? 'none') : 'none';

    if (window.tripIds1 && window.tripIds1.has(trip.trip_id)){
      serviceDateLabel = selectedLabels[0];
      const routeKey = `${trip.route_id}__${serviceDateLabel}`;
      if (!hourTrips[routeKey]) hourTrips[routeKey] = {};
      if (!hourTrips[routeKey][dir]) hourTrips[routeKey][dir] = [];
      hourTrips[routeKey][dir].push(trip);
    } 
    if (window.tripIds2 && window.tripIds2.has(trip.trip_id)){
      serviceDateLabel = selectedLabels[1];
      const routeKey = `${trip.route_id}__${serviceDateLabel}`;
      if (!hourTrips[routeKey]) hourTrips[routeKey] = {};
      if (!hourTrips[routeKey][dir]) hourTrips[routeKey][dir] = [];
      hourTrips[routeKey][dir].push(trip);
    } 
  });

  // Now, for each route/direction, normalize trip counts by distance
  const hourCounts = {};
  Object.keys(hourTrips).forEach(routeKey => {
    hourCounts[routeKey] = {};
    Object.keys(hourTrips[routeKey]).forEach(dir => {
      const tripsArr = hourTrips[routeKey][dir];
      // Get distances for each trip
      const dists = tripsArr.map(trip => shapeIdToDistance[trip.shape_id] || 0);
      const commonDist = mostCommonShapeDistByRouteDir[routeKey] && mostCommonShapeDistByRouteDir[routeKey][dir]
        ? mostCommonShapeDistByRouteDir[routeKey][dir]
        : 1;
      // Normalize: full-length or longer trips count as 1, shorter as proportion
      const normalized = dists.map(d => d >= commonDist ? 1 : d / commonDist);
      hourCounts[routeKey][dir] = normalized.reduce((a, b) => a + b, 0);
      //console.log(`For route ${routeId}: before normalization # of trips is ${tripsArr.length}. after normalization # of trips is ${normalized.reduce((a, b) => a + b, 0).toFixed(2)}. Normalization Trip Distance is ${mostCommonShapeDistByRouteDir[routeId][dir]} All Distance: ${dists}`);
    });

  });

  // Update the time series for each route
  Object.keys(hourCounts).forEach(routeKey => {
    if (!tripsPerHourSeries[routeKey]) tripsPerHourSeries[routeKey] = [];
    let yValue, annotation = null, pointStyle = 'circle';

    if (!hasDirectionId) {
      // No direction_id: sum all trips
      yValue = Object.values(hourCounts[routeKey]).reduce((a, b) => a + b, 0);
    } else {
      const dirs = Object.keys(hourCounts[routeKey]);
      if (dirs.length === 2) {
        // Both directions present: average
        yValue = (hourCounts[routeKey]['0'] + hourCounts[routeKey]['1']) / 2;
      } else if (dirs.length === 1) {
        hasOneDirectionalHourInPlot = true; // At least one route has only one direction
        // Only one direction present
        yValue = hourCounts[routeKey][dirs[0]];
        annotation = 'Only one direction present';
        pointStyle = 'rectRot'; // Use a diamond shape for this case
      }
    }

    if (yValue < 1) yValue = 1; //do not accept # of trips < 1
    tripsPerHourSeries[routeKey].push({ x: hour, y: yValue, annotation, pointStyle });
  });

  // Also add zero for routes that had previous data but no trips this hour
  Object.keys(tripsPerHourSeries).forEach(routeKey => {
    const last = tripsPerHourSeries[routeKey][tripsPerHourSeries[routeKey].length - 1];
    if (last.x < hour) {
      tripsPerHourSeries[routeKey].push({ x: hour, y: 0 });
    }
  });

  // Only plot top 10 routes by total trips so far
  let totals = Object.entries(tripsPerHourSeries).map(([routeKey, arr]) => ({
    routeKey,
    total: arr.reduce((sum, pt) => sum + pt.y, 0)
  }));
  totals.sort((a, b) => b.total - a.total);
  let top10 = totals.slice(0, 10).map(t => t.routeKey);

  tripsPerHourChart.data.datasets = top10.map((routeKey, idx) => {
    const color = tripsPerHourColors[idx % tripsPerHourColors.length];
    return {
      label: getRouteLabel(routeKey.split('__')[0]) + (routeKey.split('__')[1] ? ` (${routeKey.split('__')[1]})` : ''),
      data: tripsPerHourSeries[routeKey],
      borderColor: color,
      backgroundColor: color,
      fill: false,
      tension: 0.1,
      pointStyle: ctx => {
        const i = ctx.dataIndex;
        const pt = tripsPerHourSeries[routeKey][i];
        return pt && pt.pointStyle ? pt.pointStyle : 'circle';
      },
      pointRadius: ctx => {
        const i = ctx.dataIndex;
        const pt = tripsPerHourSeries[routeKey][i];
        if (!pt) return 3;
        if (pt.y === 0) return 1; // very small for zero trips
        if (pt.pointStyle === 'rectRot') return 10; // large for diamond
        return 5; // normal for circle
      },
      pointHoverRadius: ctx => {
        const i = ctx.dataIndex;
        const pt = tripsPerHourSeries[routeKey][i];
        if (!pt) return 4;
        if (pt.y === 0) return 2;
        if (pt.pointStyle === 'rectRot') return 12;
        return 7;
      }
    };
  });

  // Set x.min only once (on first data point)
  if (tripsPerHourChart.data.datasets.length > 0 && tripsPerHourChart.options.scales.x.min === undefined) {
    const firstDs = tripsPerHourChart.data.datasets[0];
    if (firstDs.data.length > 0) {
      tripsPerHourChart.options.scales.x.min = firstDs.data[0].x;
    }
  }
  // Always update x.max to the latest hour
  let maxX = -Infinity;
  tripsPerHourChart.data.datasets.forEach(ds => {
    if (ds.data.length > 0) {
      const lastX = ds.data[ds.data.length - 1].x;
      if (lastX > maxX) maxX = lastX;
    }
  });
  if (maxX !== -Infinity) {
    tripsPerHourChart.options.scales.x.max = maxX;
  }

  // Convert y-values to estimated headway (minutes)
  Object.values(tripsPerHourSeries).forEach(series => {
    const pt = series[series.length - 1];
    if (pt) {
      if (pt.y > 0) {
        pt.y = 60 / pt.y;
      } else {
        // Remove the last point if y == 0 (no trips)
        pt.y = null;
      }
    }
  });

  tripsPerHourChart.update();

  // --- Show annotation if no direction_id ---
  const annotationDiv = document.getElementById('tripsPerHourAnnotation');
  if (annotationDiv) {
    let annotationText = '';
    if (!hasDirectionId) {
      annotationText= 'Note: direction_id column not found in trips.txt. Headway estimation treats every trip as the same direction and could be inaccurate.';
    }
    if (hasOneDirectionalHourInPlot) {
      if (annotationText) annotationText += ' ';
      annotationText += 'Diamond datapoint represents that the trips are one-directional during this hour.';
    }
    
    annotationDiv.textContent = annotationText;
    annotationDiv.style.display = annotationText ? 'block' : 'none';    
  }
}


//#endregion