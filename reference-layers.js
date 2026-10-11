export const unitColors = ['#e1f1f2', '#b2dce0', '#67b7c2', '#247d93', '#15475f'];
export const buildingColors = ['#ed963c', '#647d95'];
const fmt = new Intl.NumberFormat('ko-KR');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const attributes = rows => `<dl class="attribute-list">${rows.map(([label,value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
const dateLabel = value => /^\d{8}$/.test(value || '') ? `${value.slice(0,4)}.${value.slice(4,6)}.${value.slice(6)}` : '자료 없음';

export function installReferenceLayers(map, {units,meta,showSelection}) {
  const unitByCode = new Map(units.features.map(feature => [feature.properties.code,feature.properties]));
  const thresholds = meta.unit_population_thresholds;
  const unitPaint = ['step', ['get','population'], unitColors[0], ...thresholds.flatMap((n,i)=>[n,unitColors[i+1]])];
  const visibility = 'none';
  map.addLayer({id:'unit-fill',type:'fill',source:'units',layout:{visibility},paint:{'fill-color':unitPaint,'fill-opacity':.5}});
  map.addLayer({id:'unit-outlines',type:'line',source:'units',layout:{visibility},paint:{'line-color':'#24718a','line-width':1.1,'line-opacity':.85}});
  map.addLayer({id:'unit-selected',type:'line',source:'units',layout:{visibility},filter:['==',['get','code'],''],paint:{'line-color':'#123f56','line-width':3}});
  let buildingsReady = false;
  let buildingPromise;
  let buildingsVisible = false;
  let unitsVisible = false;
  const setVisibility = (ids,show) => ids.forEach(id=>{if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',show?'visible':'none');});
  const pointerEvents = id => {
    map.on('mouseenter',id,()=>{map.getCanvas().style.cursor='pointer';});
    map.on('mouseleave',id,()=>{map.getCanvas().style.cursor='';});
  };
  pointerEvents('unit-fill');
  async function loadBuildings() {
    const response = await fetch(new URL('data/buildings.geojson',import.meta.url));
    if (!response.ok) throw new Error('건물 자료를 불러오지 못했습니다. 잠시 후 다시 켜주세요.');
    const data = await response.json();
    map.addSource('buildings',{type:'geojson',data,tolerance:0});
    const before = 'site-fill';
    const layout = {visibility:buildingsVisible?'visible':'none'};
    map.addLayer({id:'building-fill',type:'fill',source:'buildings',layout,paint:{
      'fill-color':['case',['get','residential'],buildingColors[0],buildingColors[1]],'fill-opacity':.85}},before);
    map.addLayer({id:'building-outlines',type:'line',source:'buildings',layout,paint:{'line-color':'#394e60','line-width':.65,'line-opacity':.8}},before);
    map.addLayer({id:'building-selected',type:'line',source:'buildings',layout,filter:['==',['id'],-1],paint:{'line-color':'#ffce53','line-width':3}},before);
    pointerEvents('building-fill');
    buildingsReady = true;
  }
  function clearHighlight() {
    if(map.getLayer('unit-selected')) map.setFilter('unit-selected',['==',['get','code'],'']);
    if(map.getLayer('building-selected')) map.setFilter('building-selected',['==',['id'],-1]);
  }
  function selectAt(point,kind) {
    if(kind==='building' && buildingsReady && buildingsVisible) {
      const [feature] = map.queryRenderedFeatures(point,{layers:['building-fill']});
      if(!feature) return false;
      clearHighlight();
      map.setFilter('building-selected',['==',['id'],feature.id]);
      const p = feature.properties;
      const unit = unitByCode.get(p.unit_code);
      const use = p.use_code==='BDU001' ? '단독주택' : p.use_code==='BDU002' ? '공동주택' : p.use_code==='BDU999' ? '용도 미상' : `기타 용도 (${p.use_code || '미상'})`;
      const rows = [['건물명',p.name || '자료 없음'],['건물 ID',p.building_id],['용도',use],['층수',p.floors>0?`${fmt.format(p.floors)}층`:'자료 없음'],
        ['도형 면적',`${fmt.format(p.area_m2)}㎡`],['사용승인일',dateLabel(p.approval_date)],['소속 집계구',p.unit_code || '자료 없음']];
      if(unit) rows.push(['집계구 총인구',`${fmt.format(unit.population)}명 (${unit.population_year}년)`]);
      showSelection('건물 정보',attributes(rows)+'<p class="selection-note">인구는 소속 집계구 전체의 값입니다. 이 건물의 실제 거주인구를 뜻하지 않습니다.</p>','building');
      return true;
    }
    if(kind==='unit' && unitsVisible) {
      const [feature] = map.queryRenderedFeatures(point,{layers:['unit-fill']});
      if(!feature) return false;
      clearHighlight();
      const p = unitByCode.get(feature.properties.code);
      map.setFilter('unit-selected',['==',['get','code'],p.code]);
      showSelection('집계구 정보',`<span class="selection-number">${fmt.format(p.population)}</span> 명 <span class="subtle">${p.population_year}년 총인구</span>`+
        attributes([['집계구 코드',p.code],['행정구역 코드',p.admin_code],['경계 기준일',dateLabel(p.boundary_date)],['구역 면적',`${fmt.format(p.area_km2)}㎢`],
          ['건물 수',`${fmt.format(p.building_count)}개`],['주거용 건물',`${fmt.format(p.residential_building_count)}개`]])+
        '<p class="selection-note">집계구 총인구는 통계 자료의 값입니다. 건물 수는 건물 도형 내부의 대표점을 기준으로 집계했습니다.</p>','unit');
      return true;
    }
    return false;
  }
  return {
    clearHighlight, selectAt,
    setUnitsVisible(show) {
      unitsVisible=show;
      setVisibility(['unit-fill','unit-outlines','unit-selected'],show);
    },
    async setBuildingsVisible(show) {
      buildingsVisible=show;
      if(show && !buildingsReady) {
        if(!buildingPromise) buildingPromise=loadBuildings().catch(error=>{buildingPromise=undefined;throw error;});
        await buildingPromise;
      }
      setVisibility(['building-fill','building-outlines','building-selected'],show);
    },
    state:()=>({buildingsVisible,buildingsReady,unitsVisible,buildingCount:meta.reference_buildings,unitCount:units.features.length})
  };
}
