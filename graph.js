
let tripPlotChart = null;
let hourTicks = []; 

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
      aspectRatio: 16 / 10,       
      animation: false,
      scales: {
        x: {
          type: 'linear',           
          title: { display: true, text: 'Time (HH:MM)' },
          ticks: {
            autoSkip: false,
            stepSize: 3600, 
            callback: function(value) {
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
              const value = context[0].parsed.x;
              const h = Math.floor(value / 3600).toString().padStart(2, '0');
              const m = Math.floor((value % 3600) / 60).toString().padStart(2, '0');
              return `${h}:${m}`;
            }
          }        
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'y'
          },
          zoom: {
            wheel: {
              enabled: true,
            },
            pinch: {
              enabled: true 
            },
            mode: 'y'
          },
          limits: {
            y: { min: 0 }
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

  const ds0 = tripPlotChart.data.datasets[0].data;
  const lastTime = ds0 && ds0.length > 0 ? ds0[ds0.length - 1].x : null;

  if (lastTime === null) {
    const zeroTime = currentTime - (TIME_STEP_SEC * speedMultiplier);
    tripPlotChart.data.datasets[0].data.push({ x: zeroTime, y: 0 });
    tripPlotChart.data.datasets[1].data.push({ x: zeroTime, y: 0 });
  }

  if (lastTime === null || currentTime - lastTime >= 60 || (count1 === 0 && count2 === 0)) {
    tripPlotChart.data.datasets[0].data.push({ x: currentTime, y: count1 });
    if (tripPlotChart.data.datasets[1]) {
      tripPlotChart.data.datasets[1].data.push({ x: currentTime, y: count2 });
    }
    
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




const vehKmColors = [
  "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00",
  "#ffff33", "#a65628", "#f781bf", "#999999", "#1b9e77"
];
let vehKmChart;
let vehKmData = []; 
let vehKmTime = 0; 

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
          aspectRatio: 16 / 10, 
          position: 'top',
          labels: { color: '#222', font: { weight: 'bold' } }
        },
        title: {
          display: true,
          text: 'Cumulative Vehicle-Kilometers by Route',
          font: { size: 14 }
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'y'
          },
          zoom: {
            wheel: {
              enabled: true,
            },
            pinch: {
              enabled: true 
            },
            mode: 'y'
          },
          limits: {
            y: { min: 0 } 
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Animation Time (s)' },
          min: undefined, 
          ticks: {
            stepSize: 3600,
            callback: function(value) {
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

    if (!vehKmPendingPoints[key]) vehKmPendingPoints[key] = [];
    vehKmPendingPoints[key].push({ x: simTime, distance: tripDistanceKm });
  } 
 }

function flushVehKmPendingPoints() {
  Object.entries(vehKmPendingPoints).forEach(([key, points]) => {
    points.sort((a, b) => a.x - b.x);
    let routeObj = vehKmData[key];
    if (!routeObj) return;
    let total = routeObj.data.length > 0 ? routeObj.data[routeObj.data.length - 1].y : 0;
    points.forEach(pt => {
      total += pt.distance;
      routeObj.data.push({ x: pt.x, y: total });
    });
    routeObj.total = total;
  });
  vehKmPendingPoints = {};

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

function getRouteLabel(routeId) {
  const route = routes.find(r => r.route_id === routeId);
  if (!route) return routeId;
  if (route.route_short_name && route.route_long_name) {
    return `${route.route_short_name} - ${route.route_long_name}`;
  }
  return route.route_short_name || route.route_long_name || route.route_id;
}


let tripsPerHourChart;
let tripsPerHourColors = vehKmColors; 
let lastTripsPerHourUpdateHour = null;
let tripsPerHourSeries = {};
let hasOneDirectionalHourInPlot = false;
let mostCommonShapeIdByRouteDir = {}; 
let mostCommonShapeDistByRouteDir = {}; 

function buildMostCommonShapeIdByRouteDir() {
  mostCommonShapeIdByRouteDir = {};
  mostCommonShapeDistByRouteDir = {};

  const countMap = {};
  trips.forEach(trip => {
    const routeId = trip.route_id;
    const dir = trip.direction_id ?? 'none';
    const shapeId = trip.shape_id;
    if (!countMap[routeId]) countMap[routeId] = {};
    if (!countMap[routeId][dir]) countMap[routeId][dir] = {};
    countMap[routeId][dir][shapeId] = (countMap[routeId][dir][shapeId] || 0) + 1;
  });

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
          aspectRatio: 16 / 10, 
          labels: { color: '#222', font: { weight: 'bold' } }
        },
        title: {
          display: true,
          text: 'Estimated Headway (mm:ss) by Route',
          font: { size: 14 }
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'y'
          },
          zoom: {
            wheel: {
              enabled: true,
            },
            pinch: {
              enabled: true 
            },
            mode: 'y'
          },
          limits: {
            y: { min: 0 }
          }
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
  const hasDirectionId = trips.some(t => t.direction_id !== undefined && t.direction_id !== '');

  const sdSel = document.getElementById('serviceDateSelect');
  const selectedLabels = Array.from(sdSel.selectedOptions).map(o => o.text);
  let serviceDateLabel = null;

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

  const hourCounts = {};
  Object.keys(hourTrips).forEach(routeKey => {
    hourCounts[routeKey] = {};
    Object.keys(hourTrips[routeKey]).forEach(dir => {
      const tripsArr = hourTrips[routeKey][dir];
      const dists = tripsArr.map(trip => shapeIdToDistance[trip.shape_id] || 0);
      const commonDist = mostCommonShapeDistByRouteDir[routeKey] && mostCommonShapeDistByRouteDir[routeKey][dir]
        ? mostCommonShapeDistByRouteDir[routeKey][dir]
        : 1;
      const normalized = dists.map(d => d >= commonDist ? 1 : d / commonDist);
      hourCounts[routeKey][dir] = normalized.reduce((a, b) => a + b, 0);
    });

  });

  Object.keys(hourCounts).forEach(routeKey => {
    if (!tripsPerHourSeries[routeKey]) tripsPerHourSeries[routeKey] = [];
    let yValue, annotation = null, pointStyle = 'circle';

    if (!hasDirectionId) {
      yValue = Object.values(hourCounts[routeKey]).reduce((a, b) => a + b, 0);
    } else {
      const dirs = Object.keys(hourCounts[routeKey]);
      if (dirs.length === 2) {
        yValue = (hourCounts[routeKey]['0'] + hourCounts[routeKey]['1']) / 2;
      } else if (dirs.length === 1) {
        hasOneDirectionalHourInPlot = true; 
        yValue = hourCounts[routeKey][dirs[0]];
        annotation = 'Only one direction present';
        pointStyle = 'rectRot'; 
      }
    }

    if (yValue < 1) yValue = 1;
    tripsPerHourSeries[routeKey].push({ x: hour, y: yValue, annotation, pointStyle });
  });

  Object.keys(tripsPerHourSeries).forEach(routeKey => {
    const last = tripsPerHourSeries[routeKey][tripsPerHourSeries[routeKey].length - 1];
    if (last.x < hour) {
      tripsPerHourSeries[routeKey].push({ x: hour, y: 0 });
    }
  });

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
        if (pt.y === 0) return 1; 
        if (pt.pointStyle === 'rectRot') return 10; 
        return 5; 
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

  if (tripsPerHourChart.data.datasets.length > 0 && tripsPerHourChart.options.scales.x.min === undefined) {
    const firstDs = tripsPerHourChart.data.datasets[0];
    if (firstDs.data.length > 0) {
      tripsPerHourChart.options.scales.x.min = firstDs.data[0].x;
    }
  }
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

  Object.values(tripsPerHourSeries).forEach(series => {
    const pt = series[series.length - 1];
    if (pt) {
      if (pt.y > 0) {
        pt.y = 60 / pt.y;
      } else {
        pt.y = null;
      }
    }
  });

  tripsPerHourChart.update();

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


