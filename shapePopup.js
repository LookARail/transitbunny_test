let highlightedShapeLayer = null;
let lastRouteIdDisplayed = null; 
let debounceTimer = null;
let pendingRouteId = null;

let suppressHideUntil = 0;
const HIDE_SUPPRESS_MS = 300;
const HOVER_OPEN_MS = 200; 

let layerHovered = false;
let canvasHovered = false;
let hideTimer = null;


function tryHideShapeInfoCanvas(immediate = false) {
  if (!immediate && Date.now() < suppressHideUntil) return;

  if (!immediate && (layerHovered || canvasHovered)) return;

  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (immediate) {
    hideShapeInfoCanvas();
  } else {
    hideTimer = setTimeout(() => {
      hideShapeInfoCanvas();
      hideTimer = null;
    }, 80);
  }
}


function showShapeInfoCanvas(routeNames, latlng, shape_id) {
  const canvas = document.getElementById('shapeInfoCanvas');
  const content = document.getElementById('shapeInfoContent');
  if (!canvas || !content) return;

  const route = shapesRoute[shape_id];
  if (!route) return;

  lastRouteIdDisplayed = route.route_id; 

  content.innerHTML = routeNames.map(n => `<div>${n}</div>`).join('');
  canvas.style.display = 'flex';

  suppressHideUntil = Date.now() + HIDE_SUPPRESS_MS;

  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  if (latlng) {

    canvas.style.top = '80px';
    canvas.style.right = '32px';
  }
  

  const allShapesForRoute = Object.keys(shapesById).filter(sid => {
    const r = shapesRoute[sid];
    return r && r.route_id === route.route_id;
  });

  const shapeOriginDestList = [];
  const missingTripIds = [];
  for (const sid of allShapesForRoute) {
    const tripsForShape = trips.filter(t => t.shape_id === sid && t.route_id === route.route_id);
    if (tripsForShape.length > 0) {
      const firstTrip = tripsForShape[0];
      const tripStops = stopTimes.filter(st => st.trip_id === firstTrip.trip_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
      if (tripStops.length > 1) {
        const firstStopName = stopsById.get(tripStops[0].stop_id)?.name || '';
        const lastStopName = stopsById.get(tripStops[tripStops.length - 1].stop_id)?.name || '';
        shapeOriginDestList.push(`${firstStopName} → ${lastStopName}`);
      } else {
        missingTripIds.push(firstTrip.trip_id);
        shapeOriginDestList.push('Loading...');
      }
    }
  }

  if (shapeOriginDestList.length) {
    content.innerHTML += `<hr>
        <div class="route-shape-list-header">Branches for this route:</div>
        <ul class="route-shape-list">
            ${shapeOriginDestList.map(s => `<li>${s}</li>`).join('')}
        </ul>`;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  pendingRouteId = route.route_id;

  if (missingTripIds.length) {

    debounceTimer = setTimeout(() => {
      if (canvas.style.display !== 'none' && lastRouteIdDisplayed === pendingRouteId) {          
        requestFilteredStopTimesFromWorker(missingTripIds).then(newStopTimes => {
        stopTimes = stopTimes.concat(newStopTimes);
        if (canvas.style.display !== 'none' && lastRouteIdDisplayed === route.route_id) {
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
                content.innerHTML = routeNames.map(n => `<div>${n}</div>`).join('') +
                `<hr>
                <div class="route-shape-list-header">Branches for this route:</div>
                <ul class="route-shape-list">
                    ${updatedList.map(s => `<li>${s}</li>`).join('')}
                </ul>`;
        }
        });
      }
    }, 300); 
  }
}




function hideShapeInfoCanvas() {
  const canvas = document.getElementById('shapeInfoCanvas');
  if (canvas) canvas.style.display = 'none';

  removeShapeHighlight();

  layerHovered = false;
  canvasHovered = false;
  suppressHideUntil = 0;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}



function addShapeHighlight(shape_id) {
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


function setupShapeHoverInfo() {
  shapesLayer.eachLayer(layer => {
    if (layer instanceof L.Polyline) {
      layer.on('mouseover', function(e) {
        layerHovered = true;

        const shape_id = layer.options.shape_id || layer.shape_id;

        addShapeHighlight(shape_id);

        if (layer._hoverOpenTimer) {
            clearTimeout(layer._hoverOpenTimer);
            layer._hoverOpenTimer = null;
            layer._pendingHoverEvent = null;
        }

        layer._pendingHoverEvent = e;

        layer._hoverOpenTimer = setTimeout(() => {
            layer._hoverOpenTimer = null;
            const pending = layer._pendingHoverEvent;
            if (!layerHovered || !pending) return;
            const shape_id = layer.options.shape_id || layer.shape_id;
            const route = shapesRoute[shape_id];
            if (!route) return;
            const routeName = `${route.route_short_name}-${route.route_long_name}`;
            showShapeInfoCanvas([routeName], pending.latlng, shape_id);
            layer._pendingHoverEvent = null;
        }, HOVER_OPEN_MS);     
      });

    layer.on('mouseout', function(e) {

        if (layer._hoverOpenTimer) {
            clearTimeout(layer._hoverOpenTimer);
            layer._hoverOpenTimer = null;
            layer._pendingHoverEvent = null;
        }

        const canvas = document.getElementById('shapeInfoCanvas');
        
        layerHovered = false;

        if (Date.now() < suppressHideUntil) return;

        if (canvas && e.relatedTarget && canvas.contains(e.relatedTarget)) {
          canvasHovered = true;
          return;
        }

        const orig = e.originalEvent || e;
        if (canvas && orig && typeof orig.clientX === 'number' && typeof orig.clientY === 'number') {
          const el = document.elementFromPoint(orig.clientX, orig.clientY);
          if (el && canvas.contains(el)) {
            canvasHovered = true;
            return;
          }
        }

        removeShapeHighlight();
        tryHideShapeInfoCanvas();
    });
        
    layer.on('click', function(e) {
        if (layer._hoverOpenTimer) {
            clearTimeout(layer._hoverOpenTimer);
            layer._hoverOpenTimer = null;
            layer._pendingHoverEvent = null;
        }

        layerHovered = true; 
        const shape_id = layer.options.shape_id || layer.shape_id;
        addShapeHighlight(shape_id);        
        const route = shapesRoute[shape_id];
        if (!route) return;
        const routeName = `${route.route_short_name}-${route.route_long_name}`;
        showShapeInfoCanvas([routeName], e.latlng, shape_id);
        L.DomEvent.stopPropagation(e);        
      });
    }
  });

  const canvasEl = document.getElementById('shapeInfoCanvas');
  if (canvasEl) {
    canvasEl.addEventListener('mouseenter', () => {
      canvasHovered = true;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    canvasEl.addEventListener('mouseleave', (ev) => {
      canvasHovered = false;

      tryHideShapeInfoCanvas();
    });
  }

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

    const closeBtn = document.querySelector('#shapeInfoCanvas .close-canvas-btn');
  if (closeBtn) closeBtn.onclick = () => tryHideShapeInfoCanvas(true);  
}
