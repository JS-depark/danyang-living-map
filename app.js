import * as THREE from './vendor/three.module.js';
import {installReferenceLayers,unitColors,buildingColors} from './reference-layers.js';

const {meta, points, site, county, units} = window.DANYANG_DATA;
const palettes = {
  purple: ['#e650b0', '#c52bb6', '#9133c8', '#563bc8', '#25136e'],
  blue: ['#17b9c2', '#138fbf', '#1670bd', '#2143a1', '#172463'],
  orange: ['#ffb02e', '#fa7c19', '#ed4f17', '#c72f21', '#851f24']
};
let colors = palettes.purple;
const display = window.DANYANG_DISPLAY;
const cutSurface = await Promise.all(['vertices','indices'].map(async name => {
  const response = await fetch(`data/cut-surface-${name}.bin`);
  if (!response.ok) throw new Error('지형 측면 자료를 불러오지 못했습니다.');
  return response.arrayBuffer();
}));
const thresholds = meta.thresholds;
const status = document.getElementById('status');
const fmt = new Intl.NumberFormat('ko-KR');
const formatEstimate = value => value < 10 ? value.toFixed(1) : fmt.format(Math.round(value));
document.getElementById('population-total').textContent = `자료 내 총인구 ${fmt.format(meta.population_total)}명`;
document.getElementById('method-text').textContent = meta.method;
document.getElementById('source-detail').textContent = `2023년 총인구 ${fmt.format(meta.population_total)}명과 2024.06.30 기준 집계구 ${meta.population_units}개를 사용했습니다. 주거용 건물 ${fmt.format(meta.residential_buildings)}개를 바탕으로 만든 추정 인구를 ${fmt.format(meta.spheres)}개의 구로 표시했습니다. 건물 레이어에서는 단양 경계 안의 건물 ${fmt.format(meta.reference_buildings)}개를 볼 수 있습니다.`;
document.getElementById('site-area').textContent = fmt.format(Math.round(meta.site.area_m2));
document.getElementById('legend-colors').innerHTML = colors.map(color => `<span style="background:${color}"></span>`).join('');
const labels = [`0–${thresholds[0]}`, ...thresholds.slice(0, -1).map((n, i) => `${n}–${thresholds[i + 1]}`), `${thresholds.at(-1)} 이상`];
const unitThresholds = meta.unit_population_thresholds;
const unitLabels = [`0–${unitThresholds[0]}`, ...unitThresholds.slice(0,-1).map((n,i)=>`${n}–${unitThresholds[i+1]}`), `${unitThresholds.at(-1)} 이상`];
document.getElementById('unit-legend-colors').innerHTML=unitColors.map(color=>`<span style="background:${color}"></span>`).join('');
document.getElementById('unit-legend-values').innerHTML=unitLabels.map(label=>`<span>${label}</span>`).join('');
const controls=document.getElementById('map-controls');
const compactControls=()=>{if(window.matchMedia('(max-width:600px), (max-height:700px)').matches) controls.open=false;};
compactControls();
window.addEventListener('resize',compactControls);
let referenceLayers;
let selectionKind;
let countyFitToken=0;
document.getElementById('legend-values').innerHTML = labels.map(label => `<span>${label}</span>`).join('');

const terrainUrl = new URL('terrain-clean/{z}/{x}/{y}.png', location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
const map = new maplibregl.Map({
  container: 'map',
  center: [meta.site.longitude + 0.006, meta.site.latitude + 0.010],
  zoom: 12.8,
  pitch: 58,
  bearing: -12,
  maxPitch: 78,
  minZoom: 7,
  maxZoom: 18,
  maxBounds: [[meta.bounds[0] - 1, meta.bounds[1] - 1], [meta.bounds[2] + 1, meta.bounds[3] + 1]],
  canvasContextAttributes: {antialias: true, preserveDrawingBuffer: true},
  style: {
    version: 8,
    sources: {
      osm: {type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, bounds:meta.bounds,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>'},
      dem: {type: 'raster-dem', tiles: [terrainUrl], tileSize: 256, minzoom: 7, maxzoom: 14,
        bounds: meta.dem_bounds, encoding: 'mapbox', attribution: '지형·건물·집계구: 제공 자료'},
      hills: {type: 'raster-dem', tiles: [terrainUrl], tileSize: 256, minzoom: 7, maxzoom: 14,
        bounds: meta.dem_bounds, encoding: 'mapbox'}
    },
    terrain: {source: 'dem', exaggeration: 1},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
      {id: 'osm', type: 'raster', source: 'osm', paint: {'raster-saturation': -.45, 'raster-contrast': -.05, 'raster-opacity': .94}},
      {id: 'hills', type: 'hillshade', source: 'hills', paint: {
        'hillshade-exaggeration': .38, 'hillshade-shadow-color': '#314e3b',
        'hillshade-highlight-color': '#fcfff5', 'hillshade-accent-color': '#617657',
        'hillshade-illumination-direction': 315, 'hillshade-illumination-anchor': 'map'}}
    ]
  }
});

map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), 'top-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({maxWidth: 130, unit: 'metric'}), 'bottom-left');
window.DANYANG_MAP = map;

let radiusPixels = 3;
let exaggeration = 1;
let visible = true;
let mesh;
let currentRadius = 0;
let forceMatrices = true;
const elevations = points.map(p => p[2]);
const origin = maplibregl.MercatorCoordinate.fromLngLat([meta.site.longitude, meta.site.latitude], 0);
const scale = origin.meterInMercatorCoordinateUnits();
const positions = points.map(p => {
  const mc = maplibregl.MercatorCoordinate.fromLngLat([p[0], p[1]], 0);
  return [(mc.x - origin.x) / scale, (mc.y - origin.y) / scale, mc.meterInMercatorCoordinateUnits() / scale];
});
const temp = new THREE.Object3D();
const colorIndex = value => thresholds.reduce((index, threshold) => index + Number(value >= threshold), 0);
const color = new THREE.Color();

function getRadius() {
  const lat = map.getCenter().lat * Math.PI / 180;
  return radiusPixels * 40075016.686 * Math.cos(lat) / (512 * 2 ** map.getZoom());
}

function refreshMatrices(force = false) {
  if (!mesh) return;
  const radius = getRadius();
  if (!force && !forceMatrices && Math.abs(radius - currentRadius) < .025) return;
  currentRadius = radius;
  forceMatrices = false;
  for (let i = 0; i < points.length; i++) {
    const [x, y, meterRatio] = positions[i];
    temp.position.set(x, y, elevations[i] * meterRatio + radius * 1.08);
    temp.scale.setScalar(radius);
    temp.updateMatrix();
    mesh.setMatrixAt(i, temp.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

const sphereLayer = {
  id: 'population-spheres',
  type: 'custom',
  renderingMode: '3d',
  onAdd(map, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.65));
    const light = new THREE.DirectionalLight(0xffffff, .55);
    light.position.set(-1, -2, 4);
    this.scene.add(light);
    const geometry = new THREE.SphereGeometry(1, 16, 12);
    const material = new THREE.MeshLambertMaterial({side: THREE.DoubleSide});
    mesh = new THREE.InstancedMesh(geometry, material, points.length);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < points.length; i++) {
      color.set(colors[colorIndex(points[i][3])]);
      mesh.setColorAt(i, color);
    }
    mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    const wallPositions = [];
    this.wallSamples = [];
    for (const ring of display.wall) {
      const samples = ring.map(p => {
        const mc = maplibregl.MercatorCoordinate.fromLngLat(p,p[2]);
        const sample = {point:p,xy:[(mc.x-origin.x)/scale,(mc.y-origin.y)/scale],z:mc.z/scale,
          meterRatio:mc.meterInMercatorCoordinateUnits()/scale,slots:[]};
        this.wallSamples.push(sample);
        return sample;
      });
      for (let i = 1; i < ring.length; i++) {
        const sa=samples[i-1],sb=samples[i];
        const a=[...sa.xy,sa.z],b=[...sb.xy,sb.z];
        const start = wallPositions.length;
        sa.slots.push(start+2,start+11);sb.slots.push(start+5);
        wallPositions.push(...a,...b,b[0],b[1],0,...a,b[0],b[1],0,a[0],a[1],0);
      }
    }
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions,3));
    wallGeometry.computeVertexNormals();
    this.wallScene = new THREE.Scene();
    this.wall = new THREE.Mesh(wallGeometry, new THREE.MeshBasicMaterial({color:'#cad5c9',side:THREE.DoubleSide}));
    this.wall.renderOrder = 1;
    this.wallScene.add(this.wall);
    const cutGeometry = new THREE.BufferGeometry();
    cutGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(cutSurface[0]),3));
    cutGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(cutSurface[1]),1));
    this.cut = new THREE.Mesh(cutGeometry,new THREE.MeshBasicMaterial({colorWrite:false,side:THREE.DoubleSide}));
    this.cut.renderOrder = 0;
    this.wallScene.add(this.cut);
    this.renderer = new THREE.WebGLRenderer({canvas: map.getCanvas(), context: gl, antialias: true});
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    refreshMatrices(true);
  },
  render(gl, args) {
    mesh.visible = visible;
    this.wall.scale.z = exaggeration;
    this.cut.scale.z = exaggeration;
    refreshMatrices();
    const matrix = args?.defaultProjectionData?.mainMatrix || args?.mainMatrix || args;
    const m = new THREE.Matrix4().fromArray(matrix);
    const local = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(scale, scale, scale));
    this.camera.projectionMatrix.copy(m.multiply(local));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.wallScene,this.camera);
    this.renderer.resetState();
  },
  onRemove() {
    mesh.geometry.dispose(); mesh.material.dispose(); this.renderer.dispose();
    this.wall.geometry.dispose();this.wall.material.dispose();
    this.cut.geometry.dispose();this.cut.material.dispose();
  }
};

let siteCallout;
let calloutLayout;
let activeView = 'town';
let manualCalloutPosition;
let labelDrag;
let lastLabelDrag = 0;
let envelopeDirty = true;
let terrainEnvelope;
const envelopeVector = new THREE.Vector3();
const envelopeVertices = new Float32Array(cutSurface[0]);
const envelopeIndices = new Uint32Array(cutSurface[1]);
let terrainTimer;
function updateTerrainPositions() {
  if (!mesh) return;
  envelopeDirty=true;
  const bounds = map.getBounds();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!bounds.contains([p[0], p[1]])) continue;
    const sampled = map.queryTerrainElevation([p[0], p[1]]);
    // Query returns the elevation including the currently selected exaggeration.
    elevations[i] = sampled !== null && sampled > 0 ? sampled : p[2] * exaggeration;
  }
  refreshMatrices(true);
  const wallPosition = sphereLayer.wall?.geometry.getAttribute('position');
  if (wallPosition) {
    for (const sample of sphereLayer.wallSamples) {
      if (!bounds.contains(sample.point)) continue;
      const height=map.queryTerrainElevation(sample.point);
      if (height !== null && height > 0) {
        for (const slot of sample.slots) wallPosition.array[slot]=height/exaggeration*sample.meterRatio;
      }
    }
    wallPosition.needsUpdate = true;
  }
  map.triggerRepaint();
}

map.on('load', () => {
  map.addSource('county', {type: 'geojson', data: county});
  map.addSource('outside', {type:'geojson',data:display.outside});
  map.addLayer({id:'outside-mask',type:'fill',source:'outside',paint:{'fill-color':'#ffffff','fill-antialias':false}});
  map.addSource('rim', {type:'geojson',data:display.rim});
  map.addLayer({id:'terrain-rim',type:'fill',source:'rim',paint:{'fill-color':'#cad5c9','fill-antialias':false}});
  map.addLayer({id: 'county-outline', type: 'line', source: 'county', paint: {'line-color': '#a8b8a6', 'line-width': .7, 'line-opacity': .6}});
  map.addSource('units', {type: 'geojson', data: units});
  referenceLayers=installReferenceLayers(map,{units,meta,showSelection});
  referenceLayers.setUnitsVisible(document.getElementById('show-units').checked);
  referenceLayers.setUnitNumbersVisible(document.getElementById('show-unit-numbers').checked);
  map.addSource('site', {type: 'geojson', data: site});
  map.addLayer({id: 'site-fill', type: 'fill', source: 'site', paint: {'fill-color': '#3479d0', 'fill-opacity': .24}});
  map.addLayer({id: 'site-outline', type: 'line', source: 'site', paint: {'line-color': '#2154bd', 'line-width': 3}});
  map.addLayer(sphereLayer);
  map.moveLayer('unit-population-labels');
  siteCallout = document.createElement('div');
  siteCallout.className = 'site-callout';
  siteCallout.innerHTML = '<svg aria-hidden="true"><path class="leader-halo" fill="none" stroke="#ffffff" stroke-width="6"/><path class="leader" fill="none" stroke="#214c9d" stroke-width="2.5"/><circle class="anchor-halo" r="6" fill="#fff"/><circle class="anchor" r="3.5" fill="#214c9d"/></svg>';
  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'site-label';
  label.textContent = '옛 KBS 중계소 부지';
  label.title = '드래그로 라벨 위치 조정 · 클릭하여 부지 정보 보기';
  label.addEventListener('pointerdown',e=>{
    if (e.button !== 0) return;
    e.preventDefault();e.stopPropagation();
    label.setPointerCapture(e.pointerId);
    labelDrag={start:[e.clientX,e.clientY],position:[calloutLayout.x,calloutLayout.y],moved:false};
    label.classList.add('dragging');
  });
  label.addEventListener('pointermove',e=>{
    if (!labelDrag) return;
    const dx=e.clientX-labelDrag.start[0],dy=e.clientY-labelDrag.start[1];
    if (Math.hypot(dx,dy)>4) labelDrag.moved=true;
    if (!labelDrag.moved) return;
    e.stopPropagation();
    manualCalloutPosition={x:labelDrag.position[0]+dx,y:labelDrag.position[1]+dy};
    updateSiteCallout();
  });
  const finishLabelDrag=e=>{
    if (!labelDrag) return;
    if (labelDrag.moved) lastLabelDrag=Date.now();
    labelDrag=undefined;label.classList.remove('dragging');
    if (label.hasPointerCapture(e.pointerId)) label.releasePointerCapture(e.pointerId);
  };
  label.addEventListener('pointerup',finishLabelDrag);
  label.addEventListener('pointercancel',finishLabelDrag);
  label.addEventListener('click', e => {
    e.stopPropagation();
    if (Date.now()-lastLabelDrag<350) return;
    showSiteSelection();
  });
  siteCallout.append(label);
  document.getElementById('map').append(siteCallout);
  updateSiteCallout();
  status.hidden = true;
  window.DANYANG_MAP_READY = true;
  updateLegend();
  map.once('idle', updateTerrainPositions);
});

function getTerrainEnvelope(width,height) {
  if (!envelopeDirty && terrainEnvelope?.width===width) return terrainEnvelope;
  const columns=new Float32Array(Math.ceil(width/16)).fill(height);
  const projection=sphereLayer.camera?.projectionMatrix;
  if (!projection) return {width,columns};
  // Sample the displayed surface, including interior summits, to find white
  // space above the terrain rather than measuring from the site alone.
  for (let i=0;i<envelopeIndices.length;i+=96) {
    const vertex=envelopeIndices[i]*3;
    envelopeVector.set(envelopeVertices[vertex],envelopeVertices[vertex+1],envelopeVertices[vertex+2]*exaggeration).applyMatrix4(projection);
    if (envelopeVector.z < -1 || envelopeVector.z > 1) continue;
    const x=(envelopeVector.x+1)*width/2,y=(1-envelopeVector.y)*height/2;
    const column=Math.floor(x/16);
    if (column < 0 || column >= columns.length) continue;
    for (let j=Math.max(0,column-1);j<=Math.min(columns.length-1,column+1);j++) columns[j]=Math.min(columns[j],y);
  }
  terrainEnvelope={width,columns};envelopeDirty=false;
  return terrainEnvelope;
}

function updateSiteCallout() {
  if (!siteCallout) return;
  const p = map.project([meta.site.longitude,meta.site.latitude]);
  const width = map.getCanvas().clientWidth, height = map.getCanvas().clientHeight;
  const label = siteCallout.querySelector('button');
  const lw = label.offsetWidth, lh = label.offsetHeight;
  const mobile = width < 600;
  let x = Math.max(12,Math.min(width-lw-55,p.x+(mobile?45:135)));
  let y = Math.max(76,Math.min(height-lh-25,p.y-(mobile?160:270)));
  if (activeView==='county' && !mobile && !manualCalloutPosition) {
    const {columns}=getTerrainEnvelope(width,height);
    const topAt=left=>{
      let top=height;
      for (let i=Math.max(0,Math.floor((left-12)/16));i<=Math.min(columns.length-1,Math.ceil((left+lw+12)/16));i++) top=Math.min(top,columns[i]);
      return top-lh-28;
    };
    const candidates=[x];
    for (let delta=32;delta<width;delta+=32) {
      if (x+delta<=width-lw-55) candidates.push(x+delta);
      if (x-delta>=255) candidates.push(x-delta);
    }
    candidates.push(Math.max(12,width-lw-55));
    const views=document.querySelector('.views').getBoundingClientRect();
    const mapBox=map.getContainer().getBoundingClientRect();
    const clearsViews=left=>left+lw<views.left-mapBox.left-12 || left>views.right-mapBox.left+12;
    const upper=candidates.find(left=>topAt(left)>=18 && clearsViews(left));
    if (upper !== undefined) {x=upper;y=18;}
    else {
      const available=candidates.find(left=>topAt(left)>=76);
      if (available !== undefined) {x=available;y=Math.min(90,topAt(x));}
      else {x=candidates.at(-1);y=76;}
    }
  }
  if (manualCalloutPosition) {
    x=Math.max(12,Math.min(width-lw-12,manualCalloutPosition.x));
    y=Math.max(12,Math.min(height-lh-12,manualCalloutPosition.y));
  }
  label.style.left = `${x}px`; label.style.top = `${y}px`;
  const end = [x+Math.min(35,lw/2),y+lh];
  const elbow = [end[0],end[1]+22];
  const d = `M ${p.x},${p.y} L ${elbow[0]},${elbow[1]} L ${end[0]},${end[1]}`;
  siteCallout.querySelectorAll('path').forEach(path=>path.setAttribute('d',d));
  siteCallout.querySelectorAll('circle').forEach(circle=>{circle.setAttribute('cx',p.x);circle.setAttribute('cy',p.y);});
  siteCallout.style.display = p.x < -20 || p.x > width+20 || p.y < -20 || p.y > height+20 ? 'none' : '';
  const style=getComputedStyle(label);
  calloutLayout = {point:[p.x,p.y],x,y,width:lw,height:lh,end,elbow,font:parseFloat(style.fontSize),paddingX:parseFloat(style.paddingLeft)};
}
map.on('render',updateSiteCallout);
map.on('move',()=>{envelopeDirty=true;});
map.on('resize',()=>{envelopeDirty=true;});

map.on('sourcedata', e => {
  if (e.sourceId !== 'dem') return;
  clearTimeout(terrainTimer);
  terrainTimer = setTimeout(updateTerrainPositions, 250);
});
map.on('moveend', updateTerrainPositions);
map.on('error', e => {
  const message = e.error?.message || String(e.error);
  console.error('Map:', message);
  if (message.includes('openstreetmap')) {
    status.hidden = false;
    status.textContent = '배경지도를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.';
  }
});

document.getElementById('sphere-size').addEventListener('input', e => {
  radiusPixels = Number(e.target.value);
  document.getElementById('sphere-size-value').textContent = radiusPixels.toFixed(1);
  forceMatrices = true; map.triggerRepaint();
});
document.getElementById('color-palette').addEventListener('change', e => {
  colors = palettes[e.target.value];
  document.getElementById('legend-colors').innerHTML = colors.map(c=>`<span style="background:${c}"></span>`).join('');
  if (mesh) {
    points.forEach((p,i)=>mesh.setColorAt(i,color.set(colors[colorIndex(p[3])])));
    mesh.instanceColor.needsUpdate = true;
  }
  map.triggerRepaint();
});
document.getElementById('terrain-scale').addEventListener('input', e => {
  exaggeration = Number(e.target.value);
  envelopeDirty=true;
  document.getElementById('terrain-scale-value').textContent = `${exaggeration.toFixed(1)}배`;
  for (let i = 0; i < points.length; i++) elevations[i] = points[i][2] * exaggeration;
  map.setTerrain({source: 'dem', exaggeration});
  refreshMatrices(true); map.triggerRepaint();
  clearTimeout(terrainTimer); terrainTimer = setTimeout(updateTerrainPositions, 350);
});
document.getElementById('show-spheres').addEventListener('change', e => {
  visible = e.target.checked; map.triggerRepaint();
  if(!visible && selectionKind==='sphere') clearSelection();
  updateLegend();
});
document.getElementById('show-units').addEventListener('change', e => {
  referenceLayers?.setUnitsVisible(e.target.checked);
  if(!e.target.checked && selectionKind==='unit') clearSelection();
  updateLegend();
});
document.getElementById('show-unit-numbers').addEventListener('change',e=>{
  referenceLayers?.setUnitNumbersVisible(e.target.checked);
  updateLegend();
});
async function setBuildingsVisible(show,{lod1}={}) {
  const checkbox=document.getElementById('show-buildings');
  checkbox.checked=show;
  if(!referenceLayers) {checkbox.checked=false;return;}
  const message=document.getElementById('buildings-status');
  const button=document.getElementById('building-3d');
  checkbox.disabled=true;button.disabled=true;
  if(checkbox.checked && !referenceLayers.state().buildingsReady) {message.hidden=false;message.textContent='건물 자료를 불러오는 중…';}
  try {
    await referenceLayers.setBuildingsVisible(checkbox.checked);
    if(typeof lod1==='boolean') await referenceLayers.setBuildings3D(lod1);
    message.hidden=true;
  } catch(error) {
    checkbox.checked=false;
    await referenceLayers.setBuildingsVisible(false);
    message.hidden=false;message.textContent='건물 자료를 불러오지 못했습니다. 잠시 후 다시 켜주세요.';
  } finally {checkbox.disabled=false;button.disabled=false;updateLegend();}
  if(!checkbox.checked && selectionKind==='building') clearSelection();
}
document.getElementById('show-buildings').addEventListener('change',e=>setBuildingsVisible(e.target.checked));
document.getElementById('building-3d').addEventListener('click',async()=>{
  const enable=!referenceLayers?.state().buildings3D;
  await setBuildingsVisible(true,{lod1:enable});
  if(referenceLayers?.state().buildings3D && map.getPitch()<35) {
    if(activeView==='county') fitCounty({pitch:50,bearing:map.getBearing(),duration:700});
    else map.easeTo({pitch:50,duration:700});
  }
});
document.getElementById('floor-height').addEventListener('input',e=>{
  document.getElementById('floor-height-value').textContent=`${Number(e.target.value).toFixed(1)}m`;
  referenceLayers?.setFloorHeight(e.target.value);
  updateLegend();
});
document.getElementById('show-site').addEventListener('change', e => {
  for (const id of ['site-fill', 'site-outline']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
  if (siteCallout) siteCallout.hidden = !e.target.checked;
  if(!e.target.checked && selectionKind==='site') clearSelection();
  updateLegend();
});

function updateLegend() {
  const buildingState=referenceLayers?.state();
  const lod1=buildingState?.buildingsVisible && buildingState?.buildings3D;
  document.getElementById('sphere-legend').hidden=!visible;
  document.getElementById('unit-legend').hidden=!document.getElementById('show-units').checked;
  document.getElementById('building-legend').hidden=!document.getElementById('show-buildings').checked;
  document.getElementById('site-legend').hidden=!document.getElementById('show-site').checked;
  document.querySelector('.legend').hidden=!['show-spheres','show-buildings','show-units','show-site'].some(id=>document.getElementById(id).checked);
  document.getElementById('sphere-size').disabled=!visible;
  document.getElementById('color-palette').disabled=!visible;
  document.getElementById('unit-number-control').hidden=!document.getElementById('show-units').checked;
  document.getElementById('unit-number-note').hidden=!document.getElementById('show-unit-numbers').checked;
  document.getElementById('building-3d').setAttribute('aria-pressed',String(Boolean(lod1)));
  document.getElementById('building-height-options').hidden=!lod1;
  document.getElementById('building-mode-legend').hidden=!lod1;
  document.getElementById('building-height-note').hidden=!lod1;
  if(lod1) document.getElementById('building-height-note').textContent=`추정 높이 = 층수 × 층당 ${buildingState.floorHeight.toFixed(1)}m`;
  if(window.DANYANG_MAP_READY) {
    const mapBox=map.getContainer().getBoundingClientRect();
    const controlsTop=controls.getBoundingClientRect().top-mapBox.top;
    const legend=document.querySelector('.legend');
    const legendTop=legend.hidden?mapBox.height-30:legend.getBoundingClientRect().top-mapBox.top;
    controls.style.maxHeight=`${Math.max(130,legendTop-controlsTop-14)}px`;
  }
}
window.addEventListener('resize',()=>{if(window.DANYANG_MAP_READY) updateLegend();});

function viewPadding() {
  const canvas=map.getCanvas();
  const width=canvas.clientWidth,height=canvas.clientHeight;
  const box=map.getContainer().getBoundingClientRect();
  const controlsBox=controls.getBoundingClientRect();
  const legend=document.querySelector('.legend');
  const legendBox=legend.getBoundingClientRect();
  const short=height<400;
  return {top:short?70:85,bottom:short?45:Math.min(190,legend.hidden?45:height-legendBox.top+box.top+18),
    left:width<600?20:controlsBox.right-box.left+24,right:width<600?20:70};
}

function projectedTerrainBounds() {
  const projection=sphereLayer.camera?.projectionMatrix;
  if(!projection) return null;
  const width=map.getCanvas().clientWidth,height=map.getCanvas().clientHeight;
  const bounds={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
  const add=(x,y,z)=>{
    envelopeVector.set(x,y,z*exaggeration).applyMatrix4(projection);
    const px=(envelopeVector.x+1)*width/2,py=(1-envelopeVector.y)*height/2;
    if(!Number.isFinite(px+py)) return;
    bounds.left=Math.min(bounds.left,px);bounds.right=Math.max(bounds.right,px);
    bounds.top=Math.min(bounds.top,py);bounds.bottom=Math.max(bounds.bottom,py);
  };
  for(const sample of sphereLayer.wallSamples || []) add(...sample.xy,sample.z);
  for(let i=0;i<envelopeIndices.length;i+=192) {
    const vertex=envelopeIndices[i]*3;
    add(envelopeVertices[vertex],envelopeVertices[vertex+1],envelopeVertices[vertex+2]);
  }
  return bounds;
}

async function fitCounty({pitch=48,bearing=-8,duration=1100}={}) {
  const token=++countyFitToken;
  const padding=viewPadding();
  const camera=map.cameraForBounds([[meta.bounds[0],meta.bounds[1]],[meta.bounds[2],meta.bounds[3]]],{padding,bearing});
  if(!camera) return;
  const arrived=map.once('moveend');
  map.easeTo({...camera,pitch,bearing,padding:0,duration});
  await arrived;
  for(let step=0;step<10 && token===countyFitToken && activeView==='county';step++) {
    const rendered=map.once('render');map.triggerRepaint();await rendered;
    const footprint=projectedTerrainBounds();
    const width=map.getCanvas().clientWidth,height=map.getCanvas().clientHeight;
    if(!footprint) break;
    const availableWidth=width-padding.left-padding.right,availableHeight=height-padding.top-padding.bottom;
    const ratio=Math.min(availableWidth/(footprint.right-footprint.left),availableHeight/(footprint.bottom-footprint.top));
    const deltaZoom=Math.max(-.7,Math.min(.7,Math.log2(ratio*.9)));
    const dx=(footprint.left+footprint.right)/2-(padding.left+availableWidth/2);
    const dy=(footprint.top+footprint.bottom)/2-(padding.top+availableHeight/2);
    if(Math.abs(deltaZoom)<.035 && Math.hypot(dx,dy)<3) break;
    const center=map.unproject([width/2+dx,height/2+dy]);
    const nextZoom=Math.max(map.getMinZoom(),Math.min(map.getMaxZoom(),map.getZoom()+deltaZoom));
    const moved=map.once('moveend');map.easeTo({center,zoom:nextZoom,padding:0,duration:100});await moved;
  }
}
map.on('movestart',e=>{if(e.originalEvent) countyFitToken++;});
map.on('moveend',()=>{
  const top=Math.abs(map.getPitch())<.01 && Math.abs(map.getBearing())<.01;
  document.getElementById('top-view').classList.toggle('selected',top);
  document.getElementById('top-view').setAttribute('aria-pressed',String(top));
});
document.getElementById('top-view').addEventListener('click',()=>{
  manualCalloutPosition=undefined;envelopeDirty=true;
  if(activeView==='county') fitCounty({pitch:0,bearing:0,duration:700});
  else {countyFitToken++;map.easeTo({pitch:0,bearing:0,padding:0,duration:700});}
});

const viewButtons = document.querySelectorAll('[data-view]');
viewButtons.forEach(button => button.addEventListener('click', () => {
  countyFitToken++;activeView=button.dataset.view;manualCalloutPosition=undefined;envelopeDirty=true;
  viewButtons.forEach(other => {
    other.classList.toggle('selected', other === button);
    other.setAttribute('aria-pressed', String(other === button));
  });
  clearSelection();
  if (button.dataset.view === 'county') {
    fitCounty();
  } else if (button.dataset.view === 'town') {
    map.flyTo({center: [meta.site.longitude + .006, meta.site.latitude + .010], zoom: 12.8, pitch: 58, bearing: -12, duration: 1100, padding: 0});
  } else {
    map.flyTo({center: [meta.site.longitude, meta.site.latitude], zoom: 15, pitch: 62, bearing: -25, duration: 1100, padding: 0});
  }
}));

const raycaster = new THREE.Raycaster();
function selectSphere(e) {
  if (!visible || !mesh || !sphereLayer.camera) return;
  const canvas = map.getCanvas();
  const nx = e.point.x / canvas.clientWidth * 2 - 1;
  const ny = 1 - e.point.y / canvas.clientHeight * 2;
  const near = new THREE.Vector3(nx, ny, -1).applyMatrix4(sphereLayer.camera.projectionMatrixInverse);
  const far = new THREE.Vector3(nx, ny, 1).applyMatrix4(sphereLayer.camera.projectionMatrixInverse);
  raycaster.set(near, far.sub(near).normalize());
  const hits = raycaster.intersectObject(mesh, false);
  if (!hits.length) return;
  const p = points[hits[0].instanceId];
  showSelection('주거 건물이 있는 100m 구역', `<span class="selection-number">${formatEstimate(p[3])}</span> 명 <span class="subtle">추정 인구</span><br>주거용 건물 ${p[4]}개<br><span class="subtle">집계구 인구를 건물 규모에 따라 배분한 값입니다.</span>`,'sphere');
  return true;
}
map.on('click', e => {
  clearSelection();
  if(referenceLayers?.selectAt(e.point,'unit-label')) return;
  if(referenceLayers?.selectAt(e.point,'building')) return;
  const hits = map.getLayer('site-fill') ? map.queryRenderedFeatures(e.point, {layers: ['site-fill']}) : [];
  if (hits.length) {
    showSiteSelection();
  } else if(!selectSphere(e)) referenceLayers?.selectAt(e.point,'unit');
});
function showSiteSelection() {
  referenceLayers?.clearHighlight();
  showSelection('옛 KBS 중계소 부지', `단양읍 도전리 산5-6<br>부지 경계 면적 ${fmt.format(Math.round(meta.site.area_m2))}㎡`,'site');
}
function showSelection(title, html, kind) {
  selectionKind=kind;
  document.getElementById('selection-title').textContent = title;
  document.getElementById('selection-content').innerHTML = html;
  document.getElementById('selection').hidden = false;
}
function clearSelection() {
  selectionKind=undefined;
  referenceLayers?.clearHighlight();
  document.getElementById('selection').hidden = true;
}
document.getElementById('close-selection').addEventListener('click',clearSelection);

function exportLegends() {
  const sections=[];
  if(visible) sections.push({kind:'range',title:'100m 구역별 추정 인구 (명)',colors,labels,note:'구 하나 = 주거 건물이 있는 100m 구역 · 건물별 실제 인구가 아닌 추정치'});
  if(document.getElementById('show-units').checked) sections.push({kind:'range',title:'집계구 총인구 (명) · 2023년',colors:unitColors,labels:unitLabels,
    note:document.getElementById('show-unit-numbers').checked?'지도 안의 숫자 = 집계구 총인구 (명)':''});
  if(document.getElementById('show-buildings').checked) {
    const state=referenceLayers?.state();
    sections.push({kind:'keys',title:state?.buildings3D?'건물 · 3D (LoD1)':'건물',colors:buildingColors,labels:['주거용','기타·미상'],
      note:state?.buildings3D?`입체 높이 = 층수 × 층당 ${state.floorHeight.toFixed(1)}m · 실제 높이 측정값이 아닌 추정치`:''});
  }
  return sections;
}

document.getElementById('export-image').addEventListener('click', async () => {
  if (map.isMoving()) await map.once('moveend');
  if (!map.areTilesLoaded()) await map.once('idle');
  map.triggerRepaint();
  await map.once('render');
  const source = map.getCanvas();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1100, source.width);
  const viewHeight = Math.round(source.height * canvas.width / source.width);
  const sections=exportLegends();
  const showSite=document.getElementById('show-site').checked;
  const footerHeight=sections.reduce((sum,section)=>sum+(section.kind==='range'?65:45)+(section.note?22:0),0)+(showSite?28:0)+45;
  canvas.height = viewHeight + 85 + footerHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#243630'; ctx.font = '600 25px "Malgun Gothic",sans-serif';
  ctx.fillText('단양, 사람이 모여 사는 곳', 30, 40);
  ctx.font = '14px "Malgun Gothic",sans-serif'; ctx.fillStyle = '#60746b';
  const layerNames=[visible?'100m 추정 인구':'',document.getElementById('show-buildings').checked?(referenceLayers?.state().buildings3D?'건물 3D (LoD1)':'건물'):'',document.getElementById('show-units').checked?'집계구 총인구':''].filter(Boolean);
  ctx.fillText(`${layerNames.join(' · ') || '단양 지형'} · 지형 높이 ${exaggeration.toFixed(1)}배`, 30, 66);
  ctx.drawImage(source, 0, 85, canvas.width, viewHeight);
  if (document.getElementById('show-site').checked && calloutLayout && siteCallout.style.display !== 'none') {
    const ratio = canvas.width / source.clientWidth;
    const label = '옛 KBS 중계소 부지';
    const c = calloutLayout;
    const x = c.x*ratio, y = 85+c.y*ratio;
    const px = c.point[0]*ratio, py = 85+c.point[1]*ratio;
    const drawLeader = () => {ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(c.elbow[0]*ratio,85+c.elbow[1]*ratio);ctx.lineTo(c.end[0]*ratio,85+c.end[1]*ratio);ctx.stroke();};
    ctx.strokeStyle='#fff';ctx.lineWidth=6*ratio;drawLeader();
    ctx.strokeStyle='#214c9d';ctx.lineWidth=2.5*ratio;drawLeader();
    ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(px,py,6*ratio,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#214c9d';ctx.beginPath();ctx.arc(px,py,3.5*ratio,0,Math.PI*2);ctx.fill();
    ctx.fillStyle = '#214c9d';
    ctx.beginPath();ctx.roundRect(x, y, c.width*ratio, c.height*ratio, 6*ratio);ctx.fill();
    ctx.font = `600 ${c.font*ratio}px "Malgun Gothic",sans-serif`;
    ctx.fillStyle = '#fff';ctx.textBaseline='middle';ctx.fillText(label,x+c.paddingX*ratio,y+c.height*ratio/2);ctx.textBaseline='alphabetic';
  }
  let row = viewHeight + 112;
  for(const section of sections) {
    ctx.fillStyle='#243630';ctx.font='13px "Malgun Gothic",sans-serif';
    ctx.fillText(section.title,30,row);
    section.colors.forEach((color,i)=>{
      ctx.fillStyle=color;
      const x=30+i*(section.kind==='range'?110:170);
      ctx.fillRect(x,row+12,section.kind==='range'?100:16,10);
      ctx.fillStyle='#42554b';ctx.font='12px "Malgun Gothic",sans-serif';
      ctx.fillText(section.labels[i],section.kind==='range'?x:x+24,row+(section.kind==='range'?42:22));
    });
    row+=section.kind==='range'?65:45;
    if(section.note) {ctx.fillStyle='#60746b';ctx.font='11px "Malgun Gothic",sans-serif';ctx.fillText(section.note,30,row);row+=22;}
  }
  if(showSite) {
    ctx.fillStyle='#3479d0';ctx.fillRect(30,row-10,16,10);
    ctx.fillStyle='#243630';ctx.font='12px "Malgun Gothic",sans-serif';ctx.fillText('옛 KBS 중계소 부지',54,row);row+=28;
  }
  ctx.fillStyle='#60746b';ctx.font='11px "Malgun Gothic",sans-serif';
  ctx.fillText('배경지도 © OpenStreetMap contributors · https://www.openstreetmap.org/copyright',30,row);
  window.DANYANG_LAST_EXPORT_LEGENDS=sections.map(section=>section.title);
  // Keep the latest rendered export available for inspection without affecting
  // the map or the downloaded PNG.
  document.getElementById('saved-view-preview')?.remove();
  const savedPreview=document.createElement('img');savedPreview.id='saved-view-preview';
  savedPreview.src=canvas.toDataURL('image/png');savedPreview.hidden=true;document.body.append(savedPreview);
  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = '단양_지형과_거주분포.png'; a.hidden=true;
    document.body.append(a);a.click();
    setTimeout(() => {URL.revokeObjectURL(url);a.remove();}, 1000);
  }, 'image/png');
});

window.DANYANG_VIEW_STATE = () => ({sphereCount: points.length, radiusPixels, exaggeration, visible,
  estimatedTotal: points.reduce((sum, p) => sum + p[3], 0), rendered: !!mesh, terrain: !!map.getTerrain(),palette:document.getElementById('color-palette').value,
  outsideMasked:!!map.getLayer('outside-mask'),solidWalls:!!sphereLayer.wall,
  references:referenceLayers?.state(),minZoom:map.getMinZoom(),zoom:map.getZoom(),pitch:map.getPitch()});
window.DANYANG_COUNTY_FOOTPRINT=projectedTerrainBounds;
