// ...existing code...

/**
 * Calculate the transit accessibility score for a given lat/lon location.
 * This function is NOT called anywhere yet.
 * @param {number} lat - Latitude of the location
 * @param {number} lon - Longitude of the location
 * @returns {number} Accessibility score (0-100)
 */
async function calculateTransitAccessibilityScore(lat, lon, filteredStops, filteredStopTimes, filteredTrips) {
  const alpha = 10;
  const searchRadiusMeters = 1000;

  //0. Pre-Compute map
  const stopTimesByStopId = {};
  for (const st of filteredStopTimes) {
    if (!stopTimesByStopId[st.stop_id]) stopTimesByStopId[st.stop_id] = [];
    stopTimesByStopId[st.stop_id].push(st);
  }
  const tripById = {};
  for (const t of filteredTrips) {
    tripById[t.trip_id] = t;
  }

  // 1. Find all stops within 1km
  const bbox = getBoundingBox(lat, lon, searchRadiusMeters);
  const stopsWithinRadius = filteredStops
    .filter(stop =>
      stop.lat >= bbox.minLat && stop.lat <= bbox.maxLat &&
      stop.lon >= bbox.minLon && stop.lon <= bbox.maxLon
    )
    .map(stop => ({
      stop,
      distance: calculateDistance(lat, lon, stop.lat, stop.lon)
    }))
    .filter(obj => obj.distance <= searchRadiusMeters);
  console.log(`Found ${stopsWithinRadius.length} stops out of ${filteredStops.length} within ${searchRadiusMeters} meters.`);

  // 2. Build shapeIdToClosestStop map
  const shapeIdToClosestStop = new Map();
  for (const { stop, distance } of stopsWithinRadius) {
    // Get all trip_ids serving this stop
    const tripIds = (stopTimesByStopId[stop.id] || []).map(st => st.trip_id);

    // For each trip, get its shape_id
    for (const tripId of tripIds) {
      const trip = tripById[tripId];
      if (trip && trip.shape_id) {
        const current = shapeIdToClosestStop.get(trip.shape_id);
        if (!current || distance < current.distance) {
          shapeIdToClosestStop.set(trip.shape_id, { stop, distance });
        }
      }
    }
  }
  console.log(`Found ${shapeIdToClosestStop.size} shape_ids with closest stops.`);


  // Helper: get all stop_times for a stop, grouped by trip
  function stopTimesForStop(stopId) {
    return stopTimesByStopId[stopId] || [];
  }

  // Helper: for a stop, get the highest hourly frequency in the day
  function highestHourlyFrequency(stopId, shapeId) {
      // Only include stop_times for trips with this shape_id
      const departures = stopTimesForStop(stopId)
          .filter(st => {
              const trip = tripById[st.trip_id];
              return trip && trip.shape_id === shapeId;
          })
          .map(st => timeToSeconds(st.departure_time));

      if (departures.length === 0) return 0;

      // Count departures per hour
      const hourCounts = {};
      for (const sec of departures) {
          const hour = Math.floor(sec / 3600);
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }

      // Get array of counts, sort descending
      const counts = Object.values(hourCounts).sort((a, b) => b - a);

      // Take top 6 hours (or fewer), average
      const topCounts = counts.slice(0, 6);
      const avg = topCounts.length ? topCounts.reduce((a, b) => a + b, 0) / topCounts.length : 0;

      return avg;
  }

  // Helper: for a stop, get total service hours with at least one trip
  function totalServiceHours(stopId, shapeId) {
    const departures = stopTimesForStop(stopId)
      .filter(st => {
        const trip = tripById[st.trip_id];
        return trip && trip.shape_id === shapeId;
      })
      .map(st => timeToSeconds(st.departure_time));

    if (departures.length === 0) return 0;
    const uniqueHours = new Set(departures.map(sec => Math.floor(sec / 3600)));
    return uniqueHours.size;
  }

  // 2. Compute default perfect stop score
  const defaultF = 10, defaultS = 18, defaultD = 150;
  const defaultStopScore = 2 * calculateStopScore(alpha, defaultF, defaultS, defaultD);

  // 3. For each stop, calculate stop score
  let sumStopScores = 0;
  for (const [shapeId, { stop, distance }] of shapeIdToClosestStop.entries()) {
    const d = distance;
    const f = highestHourlyFrequency(stop.id, shapeId);
    const s = totalServiceHours(stop.id, shapeId);
       
    // Find a trip with this shapeId
    const trip = filteredTrips.find(t => t.shape_id === shapeId);
    let routeId = trip ? trip.route_id : 'unknown';
    // If you have routes loaded globally:
    let routeName = '';
    if (typeof routes !== 'undefined' && routes.length && trip) {
      const route = routes.find(r => r.route_id === trip.route_id);
      routeName = route ? `${route.route_short_name} & ${route.route_long_name}` : '';
    }

    // Stop Score formula
    const stopScore = Math.min(33, calculateStopScore(alpha, f, s, d)); //each stop can at most score 33 point
    sumStopScores += stopScore;

    console.log(`Stop ${stop.name} (${stop.id}) for shapeID ${shapeId} and route_name=${routeName}: d=${d.toFixed(1)}m, f=${f}, s=${s.toFixed(1)}h, score contribution =${(stopScore / defaultStopScore * 100).toFixed(2)}`);
    }

  // 4. Final score
  const accessibilityScore = 100 * Math.min(1, sumStopScores / (defaultStopScore));

  console.log(`total sum of stop scores ${sumStopScores.toFixed(4)} out of ${defaultStopScore.toFixed(4)}`);
  return accessibilityScore;
}

function calculateStopScore(alpha, f, s, d){  
    return  (Math.exp(-1 * alpha / (Math.min(f, 60))) * Math.min(1, s / 18) * Math.exp( Math.max(125, d) / -150));
}

// --- Transit Accessibility Score Feature ---
let transitScoreMarker = null;
let transitScoreMapClickHandler = null;

// Show/hide and handle map click only when the canvas is active

function setupTransitScoreMapClickHandler() {
  map.on('click', async function(e) {
    const canvas = document.getElementById('transitScoreCanvas');
    const isActive = canvas && canvas.style.display !== 'none';
    if (!isActive) return;
    
    if (!filteredTrips || filteredTrips.length === 0) {
      // 1. Select all route types
      const rtSel = document.getElementById('routeTypeSelect');
      if (rtSel) {
        for (let i = 0; i < rtSel.options.length; i++) {
          rtSel.options[i].selected = true;
        }
        // Trigger the onchange event to repopulate routeShortNameSelect
        rtSel.dispatchEvent(new Event('change'));
      }

      // 2. Select all route short names
      const rsnSel = document.getElementById('routeShortNameSelect');
      if (rsnSel) {
        for (let i = 0; i < rsnSel.options.length; i++) {
          rsnSel.options[i].selected = true;
        }
        rsnSel.dispatchEvent(new Event('change'));
      }

      // 3. Select the first weekday service date (GENERIC:Monday, etc.)
      const sdSel = document.getElementById('serviceDateSelect');
      if (sdSel) {
        // Find the first option that starts with "GENERIC:"
        let found = false;
        for (let i = 0; i < sdSel.options.length; i++) {
          if (sdSel.options[i].value.startsWith("GENERIC:")) {
            // Deselect all, then select this one
            for (let j = 0; j < sdSel.options.length; j++) {
              sdSel.options[j].selected = false;
            }
            sdSel.options[i].selected = true;
            found = true;
            break;
          }
        }
        // If not found, just select the first available date
        if (!found && sdSel.options.length > 0) {
          for (let j = 0; j < sdSel.options.length; j++) {
              sdSel.options[j].selected = false;
            }
            // Try to find the first weekday (Mon-Fri)
            let selected = false;
            for (let j = 0; j < sdSel.options.length; j++) {
              const val = sdSel.options[j].value;
              // If value is a date in YYYYMMDD format
              if (/^\d{8}$/.test(val)) {
                // Parse date
                const y = +val.slice(0, 4), m = +val.slice(4, 6) - 1, d = +val.slice(6, 8);
                const dt = new Date(y, m, d);
                const day = dt.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
                if (day >= 2 && day <= 4) { // Tuesday-Thursday
                  sdSel.options[j].selected = true;
                  selected = true;
                  break;
                }
              }
            }
            // If no weekday found, select the first available date
            if (!selected) {
              sdSel.options[0].selected = true;
            }
        }
      }

      // 4. Trigger filtering
      if (typeof filterTrips === "function") filterTrips();

      showTransitScorePopup("No routes/service patterns selected. Showing results for all routes on the first weekday.");
    }

    // Remove previous marker
    removeTransitScoreMarker();
    // Show loading
    const valueElem = document.getElementById('transitScoreValue');
    valueElem.innerHTML = `<span style="font-size:1.1em; color:#aaa;">Calculating...</span>`;

    // --- Build filteredStopTimes and filteredStops from filteredTrips ---
    const filteredTripIds = new Set(filteredTrips.map(t => t.trip_id));
    const filteredStopTimes = stopTimes.filter(st => filteredTripIds.has(st.trip_id));
    const filteredStopIds = new Set(filteredStopTimes.map(st => st.stop_id));
    const filteredStops = stops.filter(s => filteredStopIds.has(s.id));
    console.log('filteredTrips:', filteredTrips.length);
    console.log('stopTimes:', stopTimes.length);
    console.log('stops:', stops.length);
    // ---------------------------------------------------------------

    // Calculate score
    const {lat, lng} = e.latlng;
    const score = await calculateTransitAccessibilityScore(lat, lng,
        filteredStops, filteredStopTimes, filteredTrips
    );
    // Place marker
    transitScoreMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'transit-score-marker',
        html: `<span style="font-size:2em; color:#43cea2;">&#9679;</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      })
    }).addTo(map);
    // Animate score color
    let color = '#185a9d';
    if (score >= 80) color = '#43cea2';
    else if (score >= 50) color = '#0078d7';
    else if (score >= 20) color = '#ff9800';
    else color = '#e53935';
    valueElem.innerHTML = `<span style="color:${color}; font-size:2.5em;">${score.toFixed(1)}</span><span style="font-size:1.1em; color:#888;"></span>`;
  });
}


function removeTransitScoreMarker() {
  if (transitScoreMarker) {
    map.removeLayer(transitScoreMarker);
    transitScoreMarker = null;
  }
}

function getBoundingBox(lat, lon, radiusMeters) {
  // Approximate radius of earth in meters
  const R = 6378137;
  const dLat = (radiusMeters / R) * (180 / Math.PI);
  const dLon = (radiusMeters / (R * Math.cos(Math.PI * lat / 180))) * (180 / Math.PI);
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon
  };
}
