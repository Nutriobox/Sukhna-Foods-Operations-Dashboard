// Reverse-geocode lat/long -> road / lane / locality via Google Geocoding API.
// This module is COMPLETE and works as soon as a valid GOOGLE_MAPS_API_KEY is set.
// It caches identical coordinates so repeated points don't cost extra requests.

const cache = new Map();

async function reverseGeocode(lat, lng, apiKey) {
  const cacheKey = `${lat},${lng}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const url =
    'https://maps.googleapis.com/maps/api/geocode/json' +
    `?latlng=${encodeURIComponent(lat)},${encodeURIComponent(lng)}` +
    `&key=${apiKey}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.results || !data.results.length) {
    const miss = { road: '', locality: '', formatted: '', status: data.status || 'NO_RESULT' };
    cache.set(cacheKey, miss);
    return miss;
  }

  const best = data.results[0];
  const comp = (type) => {
    const c = best.address_components.find((x) => x.types.includes(type));
    return c ? c.long_name : '';
  };

  const out = {
    // "road/lane" — prefer the named route; fall back to neighbourhood/sublocality.
    road: comp('route') || comp('neighborhood') || comp('sublocality') || comp('sublocality_level_1'),
    locality: comp('locality') || comp('administrative_area_level_2'),
    formatted: best.formatted_address,
    status: 'OK',
  };
  cache.set(cacheKey, out);
  return out;
}

module.exports = { reverseGeocode };
