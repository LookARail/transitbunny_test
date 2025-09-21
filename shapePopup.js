let highlightedShapeLayer = null;
let lastRouteIdDisplayed = null; // Track which route is currently shown
let debounceTimer = null;
let pendingRouteId = null;

let suppressHideUntil = 0;
const HIDE_SUPPRESS_MS = 300; // tweak between 150-400ms
const HOVER_OPEN_MS = 200; // 0.2s required hover before opening

let layerHovered = false;
let canvasHovered = false;
let hideTimer = null;


function tryHideShapeInfoCanvas(immediate = false) {
  // Respect the short suppression window after showing
  if (!immediate && Date.now() < suppressHideUntil) return;

  // If pointer is over the shape or the canvas, don't hide
  if (!immediate && (layerHovered || canvasHovered)) return;

  // Debounce to avoid flicker; immediate forces hide now
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (immediate) {
    hideShapeInfoCanvas();
  } else {
    hideTimer = setTimeout(() => {
      hideShapeInfoCanvas();
      hideTimer = null;
    }, 80); // small delay
  }
}


function showShapeInfoCanvas(routeNames, latlng, shape_id) {
  const canvas = document.getElementById('shapeInfoCanvas');
  const content = document.getElementById('shapeInfoContent');
  if (!canvas || !content) return;

    // Get route object
  const route = shapesRoute[shape_id];
  if (!route) return;

  lastRouteIdDisplayed = route.route_id; // Track for async update

  // Format route names
  content.innerHTML = routeNames.map(n => `<div>${n}</div>`).join('');
  canvas.style.display = 'flex';

  // prevent immediate hide for a short grace period (avoids flicker when canvas appears under pointer)
  suppressHideUntil = Date.now() + HIDE_SUPPRESS_MS;

  // cancel any pending hide since we're showing
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  // Position canvas near the shape (optional: adjust for mobile)
  if (latlng) {
    // Convert latlng to pixel position if needed
    // For simplicity, just keep it fixed for now
    canvas.style.top = '80px';
    canvas.style.right = '32px';
  }
  
  // --- Show all shapes for this route ---
  // Find all shapes for this route
  const allShapesForRoute = Object.keys(shapesById).filter(sid => {
    const r = shapesRoute[sid];
    return r && r.route_id === route.route_id;
  });

  // Find first trip for each shape
  const shapeOriginDestList = [];
  const missingTripIds = [];
  for (const sid of allShapesForRoute) {
    const tripsForShape = trips.filter(t => t.shape_id === sid && t.route_id === route.route_id);
    if (tripsForShape.length > 0) {
      const firstTrip = tripsForShape[0];
      // Try to get first/last stop names
      const tripStops = stopTimes.filter(st => st.trip_id === firstTrip.trip_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
      if (tripStops.length > 1) {
        const firstStopName = stopsById.get(tripStops[0].stop_id)?.name || '';
        const lastStopName = stopsById.get(tripStops[tripStops.length - 1].stop_id)?.name || '';
        shapeOriginDestList.push(`${firstStopName} → ${lastStopName}`);
      } else {
        // Missing stopTimes, need to fetch
        missingTripIds.push(firstTrip.trip_id);
        shapeOriginDestList.push('Loading...');
      }
    }
  }

  // Show initial list (may have "Loading...")
  if (shapeOriginDestList.length) {
    content.innerHTML += `<hr>
        <div class="route-shape-list-header">Branches for this route:</div>
        <ul class="route-shape-list">
            ${shapeOriginDestList.map(s => `<li>${s}</li>`).join('')}
        </ul>`;
  }

  // --- Debounce worker request ---
  if (debounceTimer) clearTimeout(debounceTimer);
  pendingRouteId = route.route_id;


  // --- If missing stopTimes, fetch in background ---
  if (missingTripIds.length) {

    debounceTimer = setTimeout(() => {
      // Only run if route hasn't changed
      if (canvas.style.display !== 'none' && lastRouteIdDisplayed === pendingRouteId) {          
        requestFilteredStopTimesFromWorker(missingTripIds).then(newStopTimes => {
        stopTimes = stopTimes.concat(newStopTimes);
        // Only update if still showing the same route
        if (canvas.style.display !== 'none' && lastRouteIdDisplayed === route.route_id) {
            // Recompute shapeOriginDestList
            const updatedList = [];
            for (const sid of allShapesForRoute) {
            const tripsForShape = trips.filter(t => t.shape_id === sid && t.route_id === route.route_id);
            if (tripsForShape.length > 0) {
                const firstTrip = tripsForShape[0];
                const tripStops = stopTimes.filter(st => st.trip_id === firstTrip.trip_id)
                .sort((a, b) => a.stop_sequence - b.stop_sequence);
                if (tripStops.length > 1) {
                const firstStopName = stopsById.get(tripStops[0].stop_id)?.name || '';
                const lastStopName = stopsById.get(tripStops[tripStops.length - 1].stop_id)?.name || '';
                updatedList.push(`${firstStopName} → ${lastStopName}`);
                } else {
                updatedList.push('Unavailable');
                }
            }
            }
            // Update canvas
                content.innerHTML = routeNames.map(n => `<div>${n}</div>`).join('') +
                `<hr>
                <div class="route-shape-list-header">Branches for this route:</div>
                <ul class="route-shape-list">
                    ${updatedList.map(s => `<li>${s}</li>`).join('')}
                </ul>`;
        }
        });
      }
    }, 300); // 500ms debounce
  }
}




function hideShapeInfoCanvas() {
  const canvas = document.getElementById('shapeInfoCanvas');
  if (canvas) canvas.style.display = 'none';

  // remove highlight
  removeShapeHighlight();

  // reset hover state & timers
  layerHovered = false;
  canvasHovered = false;
  suppressHideUntil = 0;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}



function addShapeHighlight(shape_id) {
  // remove previous
  if (highlightedShapeLayer) {
    map.removeLayer(highlightedShapeLayer);
    highlightedShapeLayer = null;
  }
  if (!shape_id || !shapesById[shape_id]) return;

  const shapePoints = shapesById[shape_id]
    .sort((a, b) => a.sequence - b.sequence)
    .map(s => [s.lat, s.lon]);

  highlightedShapeLayer = L.polyline(shapePoints, {
    color: '#888',
    weight: 8,
    opacity: 0.65,
    interactive: false,
    pane: 'shadowPane'
  }).addTo(map);
}

function removeShapeHighlight() {
  if (highlightedShapeLayer) {
    map.removeLayer(highlightedShapeLayer);
    highlightedShapeLayer = null;
  }
}


// --- Shape hover/tap logic ---
function setupShapeHoverInfo() {
  // For each polyline in shapesLayer, add event listeners
  shapesLayer.eachLayer(layer => {
    if (layer instanceof L.Polyline) {
      // Desktop: mouseover
      layer.on('mouseover', function(e) {
        layerHovered = true;

        const shape_id = layer.options.shape_id || layer.shape_id;

        // show grey underlay right away
        addShapeHighlight(shape_id);

        // clear any existing open timer (safety)
        if (layer._hoverOpenTimer) {
            clearTimeout(layer._hoverOpenTimer);
            layer._hoverOpenTimer = null;
            layer._pendingHoverEvent = null;
        }

        // store the event so we can use latlng if timer fires
        layer._pendingHoverEvent = e;

        // start timer to open canvas after HOVER_OPEN_MS
        layer._hoverOpenTimer = setTimeout(() => {
            layer._hoverOpenTimer = null;
            const pending = layer._pendingHoverEvent;
            // only open if layer is still hovered (mouse hasn't left)
            if (!layerHovered || !pending) return;
            const shape_id = layer.options.shape_id || layer.shape_id;
            const route = shapesRoute[shape_id];
            if (!route) return;
            const routeName = `${route.route_short_name}-${route.route_long_name}`;
            showShapeInfoCanvas([routeName], pending.latlng, shape_id);
            // clear stored event
            layer._pendingHoverEvent = null;
        }, HOVER_OPEN_MS);     
      });

      // Desktop: mouseout (remove highlight and popup)
    layer.on('mouseout', function(e) {

        // Cancel any pending open timer for this layer
        if (layer._hoverOpenTimer) {
            clearTimeout(layer._hoverOpenTimer);
            layer._hoverOpenTimer = null;
            layer._pendingHoverEvent = null;
        }

        const canvas = document.getElementById('shapeInfoCanvas');
        
        // Always mark layer as not hovered (mouseout means it's left the layer)
        layerHovered = false;

        // 1) short suppress window after we just showed the canvas
        if (Date.now() < suppressHideUntil) return;

        // 2) normal check: if mouse is moving into the canvas, do nothing
        if (canvas && e.relatedTarget && canvas.contains(e.relatedTarget)) {
          canvasHovered = true;
          return;
        }

        // 3) fallback: sometimes relatedTarget is null. use elementFromPoint with original mouse coords.
        const orig = e.originalEvent || e;
        if (canvas && orig && typeof orig.clientX === 'number' && typeof orig.clientY === 'number') {
          const el = document.elementFromPoint(orig.clientX, orig.clientY);
          if (el && canvas.contains(el)) {
            canvasHovered = true;
            return;
          }
        }

        // otherwise hide                
        removeShapeHighlight();
        tryHideShapeInfoCanvas();
    });
        
        // Mobile: click/tap
    layer.on('click', function(e) {
        // Cancel pending hover timer so we don't double-trigger
        if (layer._hoverOpenTimer) {
            clearTimeout(layer._hoverOpenTimer);
            layer._hoverOpenTimer = null;
            layer._pendingHoverEvent = null;
        }

        layerHovered = true; // treat click as "hovered" so popup won't immediately close
        const shape_id = layer.options.shape_id || layer.shape_id;
        addShapeHighlight(shape_id);          // ensure highlight is present
        const route = shapesRoute[shape_id];
        if (!route) return;
        const routeName = `${route.route_short_name}-${route.route_long_name}`;
        showShapeInfoCanvas([routeName], e.latlng, shape_id);
        L.DomEvent.stopPropagation(e); // Prevent map click closing immediately        
      });
    }
  });

  const canvasEl = document.getElementById('shapeInfoCanvas');
  if (canvasEl) {
    canvasEl.addEventListener('mouseenter', () => {
      canvasHovered = true;
      // cancel any hide timer while inside the canvas
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    canvasEl.addEventListener('mouseleave', (ev) => {
      // If the mouse leaves the canvas, try hide (but respect suppression/hide debounce)
      canvasHovered = false;

      // If pointer moved back to the shape (rare), layerHovered might already be true; tryHide will handle it.
      tryHideShapeInfoCanvas();
    });
  }

  // Close canvas when clicking outside
  document.addEventListener('mousedown', function(e) {
    const canvas = document.getElementById('shapeInfoCanvas');
    if (!canvas) return;
    if (canvas.style.display !== 'none' && !canvas.contains(e.target)) {
      tryHideShapeInfoCanvas(true);
    }
  });
  document.addEventListener('touchstart', function(e) {
    const canvas = document.getElementById('shapeInfoCanvas');
    if (!canvas) return;
    if (canvas.style.display !== 'none' && !canvas.contains(e.target)) {
      tryHideShapeInfoCanvas(true);
    }
  });

  // Close button
    const closeBtn = document.querySelector('#shapeInfoCanvas .close-canvas-btn');
  if (closeBtn) closeBtn.onclick = () => tryHideShapeInfoCanvas(true);  
}
