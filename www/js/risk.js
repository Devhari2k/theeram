// Theeram — shared risk engine.
//
// The single authoritative implementation of Theeram's risk calculation.
// Extracted verbatim from www/index.html in Phase 2.4.1 so that the browser
// app and the future scheduled monitor compute risk from the same code
// rather than two copies that drift apart.
//
// IMPORTANT — this is a rainfall-and-elevation RISK PROXY, not a
// hydrological flood forecast. It has no river stage, reservoir level, soil
// moisture, drainage or tide input. Treat its output as an informational
// signal, never as an official warning.
//
// Dependency-free and environment-neutral on purpose: no DOM, no fetch, no
// Firestore, no Node built-ins. Importable by the browser (via the module
// bridge in index.html) and by Node.
//
// The behaviour below is a PURE REFACTOR of the shipped implementation.
// Two quirks are preserved deliberately rather than corrected, because the
// production app has always behaved this way and Phase 2.4.1 is explicitly
// not allowed to change risk output:
//
//   1. sumLastNHours(n) sums n+1 samples, not n — the loop runs from
//      (nowIdx - n) to nowIdx inclusive. "r24" is therefore a 25-sample sum.
//   2. classifyTerrain() screens with isNaN(), which coerces: '' and false
//      are treated as elevation 0 and classify as Coastal.
//
// Changing either is a risk-model change and belongs in its own phase.

const TERRAIN_ICONS = {
  coastal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M2 15C3.5 13 5.5 13 7 15C8.5 17 10.5 17 12 15C13.5 13 15.5 13 17 15C18.5 17 20.5 17 22 15" stroke="#3FA7D6" stroke-width="1.8" stroke-linecap="round"/><path d="M2 19C3.5 17 5.5 17 7 19C8.5 21 10.5 21 12 19C13.5 17 15.5 17 17 19C18.5 21 20.5 21 22 19" stroke="#3FA7D6" stroke-width="1.8" stroke-linecap="round" opacity="0.5"/></svg>',
  floodplain: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="14" width="18" height="7" rx="1" stroke="#3FA7D6" stroke-width="1.6"/><path d="M3 14L9 8L13 11L21 4" stroke="#3FA7D6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  midland: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M2 19L8 9L12 14L16 7L22 19" stroke="#3FA7D6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  highland: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M2 19L9 5L13 12L16 8L22 19" stroke="#3FA7D6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 5L11 9H7L9 5Z" fill="#3FA7D6"/></svg>'
};

function classifyTerrain(elevation){
  if(elevation == null || isNaN(elevation)) return null;
  if(elevation < 8){
    return { type:'Coastal', icon: TERRAIN_ICONS.coastal, desc:'Coastal lowland — tidal and storm-surge exposure compounds with rainfall.' };
  } else if(elevation < 40){
    return { type:'Low-lying floodplain', icon: TERRAIN_ICONS.floodplain, desc:'Flat, low terrain — water tends to pool and drain slowly here.' };
  } else if(elevation < 150){
    return { type:'Midland', icon: TERRAIN_ICONS.midland, desc:'Gently sloped midland — moderate runoff, lower standing-water risk.' };
  } else {
    return { type:'Highland', icon: TERRAIN_ICONS.highland, desc:'Higher elevation — lower flood risk, but watch landslide-prone slopes.' };
  }
}

function computeRisk(rain){
  // Based on IMD rainfall intensity classification (mm in 24h):
  // Heavy: 64.5-115.5, Very Heavy: 115.6-204.4, Extremely Heavy: >204.5
  const { r24, r48, r72 } = rain;
  let level, pct, color, reason;

  if(r24 >= 204.5 || r48 >= 300){
    level = 'Severe'; pct = 95; color = 'var(--coral)';
    reason = `Extremely heavy rainfall detected — ${r24}mm in the last 24h. This crosses IMD's "extremely heavy" threshold.`;
  } else if(r24 >= 115.6 || r48 >= 180){
    level = 'High'; pct = 72; color = 'var(--amber)';
    reason = `Very heavy rainfall — ${r24}mm in 24h, ${r48}mm over 48h. Ground saturation risk is elevated.`;
  } else if(r24 >= 64.5 || r72 >= 150){
    level = 'Moderate'; pct = 45; color = 'var(--amber)';
    reason = `Heavy rainfall recorded — ${r24}mm in the last 24h. Worth monitoring, especially in low-lying or coastal areas.`;
  } else if(r24 > 20 || r72 > 60){
    level = 'Low'; pct = 20; color = 'var(--safe)';
    reason = `Rainfall is light to moderate (${r24}mm/24h). No elevated flood signal right now.`;
  } else {
    level = 'Minimal'; pct = 6; color = 'var(--safe)';
    reason = `Little to no recent rainfall (${r24}mm/24h) recorded for this location.`;
  }
  return { level, pct, color, reason };
}

function isHighOrExtreme(level){ return level === 'High' || level === 'Severe'; }

// The aggregation half of the former fetchRainfall(): everything after the
// network call. Takes Open-Meteo's `hourly` object ({ time, precipitation }).
// `nowInput` exists only so tests and the monitor can pin the clock; omitted,
// it is `new Date()` exactly as before.
function summarizeRainfall(hourly, nowInput){
  const hours = hourly.precipitation;
  const times = hourly.time;
  const now = nowInput === undefined ? new Date() : nowInput;
  // "now" is approximated as the last hour at/before the current time.
  let nowIdx = times.length - 1;
  for(let i = 0; i < times.length; i++){
    if(new Date(times[i]) > now){ nowIdx = Math.max(0, i - 1); break; }
  }
  function sumLastNHours(n){
    let sum = 0;
    for(let i = Math.max(0, nowIdx - n); i <= nowIdx; i++){
      if(hours[i] != null) sum += hours[i];
    }
    return Math.round(sum * 10) / 10;
  }
  function sumNextNHours(n){
    let sum = 0;
    for(let i = nowIdx + 1; i <= Math.min(hours.length - 1, nowIdx + n); i++){
      if(hours[i] != null) sum += hours[i];
    }
    return Math.round(sum * 10) / 10;
  }
  return {
    r24: sumLastNHours(24),
    r48: sumLastNHours(48),
    r72: sumLastNHours(72),
    forecastNext24h: sumNextNHours(24)
  };
}

// Kept beside the window maths they are coupled to: past_days/forecast_days
// determine whether the 72h trailing and 24h forward windows have any data
// to sum, so the URL and the aggregation must not drift apart.
function buildForecastUrl(lat, lon){
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation&past_days=3&forecast_days=2&timezone=auto`;
}

function buildElevationUrl(lat, lon){
  return `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
}

export {
  TERRAIN_ICONS,
  classifyTerrain,
  computeRisk,
  isHighOrExtreme,
  summarizeRainfall,
  buildForecastUrl,
  buildElevationUrl
};
