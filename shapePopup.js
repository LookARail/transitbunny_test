let highlightedShapeLayer = null;

function showShapeInfoCanvas(routeNames, latlng, shape_id) {
  const canvas = document.getElementById('shapeInfoCanvas');
  const content = document.getElementById('shapeInfoContent');
  if (!canvas || !content) return;

  // Format route names
  content.innerHTML = routeNames.map(n => `<div>${n}</div>`).join('');
  canvas.style.display = 'flex';

  // Position canvas near the shape (optional: adjust for mobile)
  if (latlng) {
    // Convert latlng to pixel position if needed
    // For simplicity, just keep it fixed for now
    canvas.style.top = '80px';
    canvas.style.right = '32px';
  }
  
  // Remove previous highlight
  if (highlightedShapeLayer) {
    map.removeLayer(highlightedShapeLayer);
    highlightedShapeLayer = null;
  }

  // Add highlight for the hovered/clicked shape
  if (shape_id && shapesById[shape_id]) {
    const shapePoints = shapesById[shape_id]
      .sort((a, b) => a.sequence - b.sequence)
      .map(s => [s.lat, s.lon]);
    highlightedShapeLayer = L.polyline(shapePoints, {
      color: '#888',
      weight: 8,
      opacity: 0.65,
      interactive: false, // not clickable
      pane: 'shadowPane' // below overlays (optional, see below)
    }).addTo(map);
  }
}

function hideShapeInfoCanvas() {
  const canvas = document.getElementById('shapeInfoCanvas');
  if (canvas) canvas.style.display = 'none';
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
        const shape_id = layer.options.shape_id || layer.shape_id;
        const route = shapesRoute[shape_id];
        if (!route) return;
        const routeName = `${route.route_short_name}-${route.route_long_name}`;
        showShapeInfoCanvas([routeName], e.latlng, shape_id);        
      });
      // Desktop: mouseout (remove highlight and popup)
        layer.on('mouseout', function(e) {
        hideShapeInfoCanvas();
        });
      // Mobile: click/tap
      layer.on('click', function(e) {
        const shape_id = layer.options.shape_id || layer.shape_id;
        const route = shapesRoute[shape_id];
        if (!route) return;
        const routeName = `${route.route_short_name}-${route.route_long_name}`;
        showShapeInfoCanvas([routeName], e.latlng, shape_id);
        L.DomEvent.stopPropagation(e); // Prevent map click closing immediately        
      });
    }
  });

  // Close canvas when clicking outside
  document.addEventListener('mousedown', function(e) {
    const canvas = document.getElementById('shapeInfoCanvas');
    if (!canvas) return;
    if (canvas.style.display !== 'none' && !canvas.contains(e.target)) {
      hideShapeInfoCanvas();
    }
  });
  document.addEventListener('touchstart', function(e) {
    const canvas = document.getElementById('shapeInfoCanvas');
    if (!canvas) return;
    if (canvas.style.display !== 'none' && !canvas.contains(e.target)) {
      hideShapeInfoCanvas();
    }
  });

  // Close button
  document.querySelector('#shapeInfoCanvas .close-canvas-btn').onclick = hideShapeInfoCanvas;
}
