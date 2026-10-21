#engine v8

// ============================================================================
// Gaia_StarColors.js  -  Recolor SHO stars with Gaia colors to get RGB stars
//
// Input: a star image (stars only, e.g. SHO stars from StarXTerminator) that is
// plate solved. The brightness of every star stays from the image, the color
// comes from Gaia (BP-RP):
//
//   1. Load the Gaia stars of the image field (local XPSD or online VizieR),
//      proper motion applied to the observation time, converted to pixels.
//   2. BP-RP -> temperature (main sequence, Pecaut & Mamajek) -> blackbody
//      -> CIE 1931 XYZ -> linear sRGB. Optionally the Sun (G2V) is made neutral,
//      like in Photometric Color Calibration.
//   3. Every Gaia star is placed on its brightness maximum in the image (search
//      window, a local maximum is required). A common position offset of the
//      solution is estimated beforehand and subtracted.
//   4. From the maximum, the image is flooded in descending order of brightness
//      (watershed): every pixel belongs to the star whose flood reaches it first.
//      This happens in two stages: nearly saturated stars flood first and thereby
//      own their entire halo including the spikes. All other stars afterwards only
//      take pixels where their own light matters (gate: modeled own light >= 15 %
//      of the pixel value). Field stars in the middle of a halo thus keep their
//      color without breaking the halo into patches and rays. The reach grows with
//      the brightness (up to three times).
//   5. Recoloring is done pixel by pixel: brightness from the star image times the
//      Gaia color (mean preserving). Overexposed cores are desaturated towards the
//      center and thus fade to white, like with an RGB camera. Faint pixels (halos,
//      valleys between stars, star wings without an assignment) get the
//      brightness-weighted color of their surroundings, so that no hard color edge
//      appears between two stars.
//   6. Stars without a Gaia color or without a Gaia entry get a color estimated
//      from their original (narrowband) color: from the matched stars the script
//      learns how the channel ratios translate into BP-RP.
//
// Pixels without any Gaia assignment nearby (leftovers) become neutral (brightness
// as gray) or keep their original color.
//
// Result (new windows):
//   <id>_RGB     3-channel star image, keeps the astrometric solution and the STF
//   <id>_gmask   optional: weight of the Gaia coloring per pixel (0..1)
//
// Requirements: astrometric solution in the image (ImageSolver); Gaia DR3
// database (XPSD) installed locally or internet access for VizieR.
// ============================================================================

#feature-id    pmneoAstro > Gaia Star Colors
#feature-info  Recolors a SHO star image with Gaia colors (BP-RP) to produce RGB stars. Requires an astrometric solution and Gaia DR3 (XPSD or VizieR).

CoreApplication.ensureMinimumVersion( 1, 9, 5 );

#define GSC_VERSION  "1.0"
#define GSC_KEY      "GaiaStarColors/"

// The include files read SETTINGS_MODULE already at load time (catalog registration),
// so it has to be defined before the includes.
#define SETTINGS_MODULE "GaiaStarColors"

#include <pjsr/astrometry/AstrometricMetadata.js>
#include <pjsr/astrometry/AstronomicalCatalogs.js>

// ============================ CORE (no PJSR) ================================
// Pure computation on typed arrays. For testing outside PixInsight it is cut out
// between the markers CORE / END CORE.

const BPRP_MIN = -0.60, BPRP_MAX = 5.20, BPRP_STEP = 0.01;
const MIN_COLOR = 0.02;

// Main sequence BP-RP -> Teff: Pecaut & Mamajek, EEM_dwarf_UBVIJHK_colors_Teff.txt,
// version 2022.04.16 (BP-RP from B9V to M8.5V). Above 10700 K (BP-RP < -0.12) the
// anchor points are rough estimates; the sRGB color hardly changes there.
const BPRP_TEFF = [
   [-0.45, 35000], [-0.35, 25000], [-0.28, 19000], [-0.20, 14000],
   [-0.120, 10700], [-0.087, 10400], [-0.037, 9700], [0.005, 9300],
   [0.068, 8800], [0.166, 8250], [0.194, 8100], [0.263, 7760],
   [0.327, 7400], [0.377, 7220], [0.490, 6820], [0.587, 6550],
   [0.670, 6280], [0.719, 6050], [0.784, 5930], [0.823, 5770],
   [0.850, 5660], [0.900, 5480], [0.983, 5270], [1.10, 5100],
   [1.21, 4830], [1.34, 4600], [1.43, 4440], [1.53, 4300],
   [1.70, 4100], [1.84, 3850], [2.09, 3660], [2.23, 3560],
   [2.50, 3430], [2.94, 3210], [3.35, 3060], [4.16, 2810],
   [4.65, 2680], [4.86, 2570], [5.10, 2420]
];

// CIE 1931 color matching functions, analytic approximation (Wyman, Sloan, Shirley 2013)
function cieLobe( l, mu, s1, s2 )
{
   const t = (l - mu) / (l < mu ? s1 : s2);
   return Math.exp( -0.5 * t * t );
}

function teffFromBpRp( c )
{
   const t = BPRP_TEFF, n = t.length;
   if ( c <= t[0][0] ) return t[0][1];
   if ( c >= t[n-1][0] ) return t[n-1][1];
   let i = 1;
   while ( t[i][0] < c ) ++i;
   const f = (c - t[i-1][0]) / (t[i][0] - t[i-1][0]);
   const a = Math.log( t[i-1][1] ), b = Math.log( t[i][1] );
   return Math.exp( a + f * (b - a) );
}

// Blackbody at T kelvin as linear sRGB, normalized to a maximum of 1
function planckLinearRGB( T )
{
   let X = 0, Y = 0, Z = 0;
   for ( let l = 380; l <= 780; l += 5 )
   {
      const b = 1 / (Math.pow( l, 5 ) * (Math.exp( 1.4388e7 / (l * T) ) - 1));
      X += b * (1.056 * cieLobe( l, 599.8, 37.9, 31.0 ) + 0.362 * cieLobe( l, 442.0, 16.0, 26.7 )
                - 0.065 * cieLobe( l, 501.1, 20.4, 26.2 ));
      Y += b * (0.821 * cieLobe( l, 568.8, 46.9, 40.5 ) + 0.286 * cieLobe( l, 530.9, 16.3, 31.1 ));
      Z += b * (1.217 * cieLobe( l, 437.0, 11.8, 36.0 ) + 0.681 * cieLobe( l, 459.0, 26.0, 13.8 ));
   }
   const r =  3.2406 * X - 1.5372 * Y - 0.4986 * Z;
   const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
   const bl = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
   const m = Math.max( r, g, bl );
   return [Math.max( r / m, 0.01 ), Math.max( g / m, 0.01 ), Math.max( bl / m, 0.01 )];
}

// Color table over BP-RP: each entry (r,g,b) with mean 1.
// sunNeutral: the Sun (G2V, 5772 K) becomes white. saturation: 1 = unchanged.
function buildColorLUT( sunNeutral, saturation )
{
   const n = Math.round( (BPRP_MAX - BPRP_MIN) / BPRP_STEP ) + 1;
   const lut = new Float32Array( 3 * n );
   const ref = sunNeutral ? planckLinearRGB( 5772 ) : [1, 1, 1];
   for ( let i = 0; i < n; ++i )
   {
      const c = planckLinearRGB( teffFromBpRp( BPRP_MIN + i * BPRP_STEP ) );
      let r = c[0] / ref[0], g = c[1] / ref[1], b = c[2] / ref[2];
      let m = (r + g + b) / 3;
      r /= m; g /= m; b /= m;
      r = Math.max( MIN_COLOR, 1 + saturation * (r - 1) );
      g = Math.max( MIN_COLOR, 1 + saturation * (g - 1) );
      b = Math.max( MIN_COLOR, 1 + saturation * (b - 1) );
      m = (r + g + b) / 3;
      lut[3*i] = r / m; lut[3*i + 1] = g / m; lut[3*i + 2] = b / m;
   }
   return lut;
}

function lutIndex( bprp )
{
   const n = Math.round( (BPRP_MAX - BPRP_MIN) / BPRP_STEP ) + 1;
   const i = Math.round( (bprp - BPRP_MIN) / BPRP_STEP );
   return i < 0 ? 0 : (i >= n ? n - 1 : i);
}

// Background (median) and noise (1.4826*MAD) from a sample
function estimateBackground( L, N )
{
   const step = Math.max( 1, Math.floor( N / 400000 ) );
   let s = new Float32Array( Math.ceil( N / step ) ), n = 0;
   for ( let i = 0; i < N; i += step )
      s[n++] = L[i];
   s = s.subarray( 0, n );
   s.sort();
   const bg = s[n >> 1];
   const d = new Float32Array( n );
   for ( let j = 0; j < n; ++j )
      d[j] = Math.abs( s[j] - bg );
   d.sort();
   return { bg: bg, sigma: 1.4826 * d[n >> 1] };
}

function isLocalMax( L, W, H, x, y )
{
   const v = L[y * W + x];
   for ( let dy = -1; dy <= 1; ++dy )
   {
      const yy = y + dy;
      if ( yy < 0 || yy >= H ) continue;
      for ( let dx = -1; dx <= 1; ++dx )
      {
         const xx = x + dx;
         if ( (dx == 0 && dy == 0) || xx < 0 || xx >= W ) continue;
         if ( L[yy * W + xx] > v ) return false;
      }
   }
   return true;
}

// Places every Gaia star (order: bright first) on the image maximum within the
// search window. A pixel belongs only to the brightest star that claims it.
// sx, sy: pixel position (pixel center at +0.5), ox, oy: common offset.
function findSeeds( L, W, H, sx, sy, order, ox, oy, win, Tseed )
{
   const cap = order.length;
   const pix = new Int32Array( cap ), star = new Int32Array( cap );
   const claimed = new Set();
   const r = Math.ceil( win ), win2 = win * win;
   let n = 0;
   for ( let oi = 0; oi < cap; ++oi )
   {
      const s = order[oi];
      const x = sx[s] + ox, y = sy[s] + oy;
      if ( x < 0 || y < 0 || x >= W || y >= H ) continue;
      const px = Math.floor( x ), py = Math.floor( y );
      let best = -1, bv = Tseed, bx = 0, by = 0, bd = 1e30;
      for ( let yy = py - r; yy <= py + r; ++yy )
      {
         if ( yy < 0 || yy >= H ) continue;
         for ( let xx = px - r; xx <= px + r; ++xx )
         {
            if ( xx < 0 || xx >= W ) continue;
            const ddx = xx + 0.5 - x, ddy = yy + 0.5 - y, d2 = ddx * ddx + ddy * ddy;
            if ( d2 > win2 ) continue;
            const v = L[yy * W + xx];
            if ( v > bv || (best >= 0 && v == bv && d2 < bd) )
            {
               bv = v; best = yy * W + xx; bx = xx; by = yy; bd = d2;
            }
         }
      }
      if ( best < 0 || !isLocalMax( L, W, H, bx, by ) || claimed.has( best ) ) continue;
      claimed.add( best );
      pix[n] = best; star[n] = s; ++n;
   }
   return { n: n, pix: pix.subarray( 0, n ), star: star.subarray( 0, n ) };
}

function medianOf( a )
{
   const s = Float64Array.from( a ).sort();
   return s[s.length >> 1];
}

// Common offset image - Gaia from bright, unsaturated stars (centroid in the 3x3
// window around the maximum). Returns offset and spread.
function estimateOffset( L, W, H, sx, sy, order, win, Tseed, Lmax )
{
   const s1 = findSeeds( L, W, H, sx, sy, order, 0, 0, win * 1.7, Tseed );
   const dxs = [], dys = [];
   for ( let k = 0; k < s1.n; ++k )
   {
      const p = s1.pix[k], v = L[p];
      if ( v < 30 * Tseed || v > 0.9 * Lmax ) continue;
      const x = p % W, y = (p - x) / W;
      let sw = 0, cx = 0, cy = 0;
      for ( let dy = -1; dy <= 1; ++dy )
         for ( let dx = -1; dx <= 1; ++dx )
         {
            const xx = x + dx, yy = y + dy;
            if ( xx < 0 || yy < 0 || xx >= W || yy >= H ) continue;
            const w = L[yy * W + xx];
            sw += w; cx += w * (xx + 0.5); cy += w * (yy + 0.5);
         }
      const s = s1.star[k];
      dxs.push( cx / sw - sx[s] );
      dys.push( cy / sw - sy[s] );
   }
   if ( dxs.length < 20 )
      return { dx: 0, dy: 0, n: dxs.length, spread: 0 };
   const mx = medianOf( dxs ), my = medianOf( dys );
   const dev = [];
   for ( let k = 0; k < dxs.length; ++k )
      dev.push( Math.hypot( dxs[k] - mx, dys[k] - my ) );
   return { dx: mx, dy: my, n: dxs.length, spread: medianOf( dev ) };
}

// Seeds with a peak >= OWNER_FRAC * maximum (nearly saturated stars) own their halo:
// they flood first and without restriction. All other stars (field stars, often in the
// middle of a halo) may only take pixels where their own light matters: the modeled own
// brightness (excess over the surrounding level times a Moffat profile) must make up at
// least GATE_GAMMA of the measured pixel value. Without this gate they spread through the
// flat, noisy halo plateau like percolation (streaks, patches, whole rings in a foreign
// color). The profile is only a loose gate, its inaccuracy hardly matters: pixels it
// rejects are colored by the soft color field.
const OWNER_FRAC = 0.2;
const GATE_GAMMA = 0.15;
const GATE_BETA  = 2.5;

// Full width at half maximum in pixels from bright, unsaturated seeds (area above half the peak)
function estimateFWHM( L, W, H, pix, peak, T, Lmax )
{
   const R = 9, S = 2 * R + 1, areas = [];
   const vis = new Uint8Array( S * S ), stack = new Int32Array( S * S );
   const step = Math.max( 1, Math.floor( pix.length / 400 ) );
   for ( let k = 0; k < pix.length && areas.length < 300; k += step )
   {
      const p = peak[k];
      if ( p < 30 * T || p > 0.7 * Lmax ) continue;
      const x0 = pix[k] % W, y0 = (pix[k] - x0) / W, half = 0.5 * p;
      vis.fill( 0 );
      let sp = 0, area = 0;
      stack[sp++] = R * S + R; vis[R * S + R] = 1;
      while ( sp > 0 )
      {
         const c = stack[--sp], cx = c % S, cy = (c - cx) / S;
         ++area;
         for ( let d = 0; d < 4; ++d )
         {
            const nx = cx + (d == 0) - (d == 1), ny = cy + (d == 2) - (d == 3);
            if ( nx < 0 || ny < 0 || nx >= S || ny >= S || vis[ny * S + nx] ) continue;
            const xx = x0 + nx - R, yy = y0 + ny - R;
            if ( xx < 0 || yy < 0 || xx >= W || yy >= H || L[yy * W + xx] < half ) continue;
            vis[ny * S + nx] = 1; stack[sp++] = ny * S + nx;
         }
      }
      areas.push( area );
   }
   if ( areas.length < 10 ) return 3;
   return Math.min( 12, Math.max( 1.5, 2 * Math.sqrt( medianOf( areas ) / Math.PI ) ) );
}

// Own light of the field stars (non-owners): peak minus surrounding level h, measured as the
// median on two rings around the star (if a star sits in a halo, h is high).
function seedExcess( L, W, H, cx, cy, peak, owner, fwhm )
{
   const n = peak.length, ex = new Float32Array( n ), v = new Float32Array( 24 );
   const radii = [Math.max( 5, 2.2 * fwhm ), Math.max( 8, 3.5 * fwhm )];
   for ( let k = 0; k < n; ++k )
   {
      if ( owner[k] ) continue;
      let m = 0;
      for ( let a = 0; a < 12; ++a )
      {
         const co = Math.cos( a * Math.PI / 6 + 0.3 ), si = Math.sin( a * Math.PI / 6 + 0.3 );
         for ( let q = 0; q < 2; ++q )
         {
            const x = Math.min( W - 1, Math.max( 0, Math.floor( cx[k] + radii[q] * co ) ) );
            const y = Math.min( H - 1, Math.max( 0, Math.floor( cy[k] + radii[q] * si ) ) );
            v[m++] = L[y * W + x];
         }
      }
      v.sort();
      ex[k] = Math.max( 0, peak[k] - 0.5 * (v[11] + v[12]) );
   }
   return ex;
}

// Watershed from the seeds in active, in descending order of brightness (bucket queue
// with logarithmic buckets). labels: 0 = unassigned, otherwise seed + 1. A pixel is only
// flooded if L > T, it is at most reachK[seed] away from the seed (Gaia position cx, cy)
// and it does not yet belong to a star. With excess (second stage) the gate applies as
// well: excess[seed] * (1 + d^2/alpha^2)^-GATE_BETA >= GATE_GAMMA * L; with owner, pixels
// that belong to an owner may then be overwritten too.
function floodLabels( L, W, H, labels, next, active, pix, cx, cy, excess, alpha, reachK, owner, T, Lmax )
{
   const NB = 4096;
   const head = new Int32Array( NB ).fill( -1 );
   const logT = Math.log( T );
   const bscale = (NB - 1) / Math.max( 1e-9, Math.log( Lmax ) - logT );
   const invA2 = 1 / (alpha * alpha);
   let cur = -1;

   const bucket = v => {
      const b = ((Math.log( v ) - logT) * bscale) | 0;
      return b < 0 ? 0 : (b >= NB ? NB - 1 : b);
   };

   for ( let a = 0; a < active.length; ++a )
   {
      const k = active[a], p = pix[k];
      labels[p] = k + 1;
      const b = bucket( L[p] );
      next[p] = head[b]; head[b] = p;
      if ( b > cur ) cur = b;
   }

   while ( true )
   {
      while ( cur >= 0 && head[cur] < 0 ) --cur;
      if ( cur < 0 ) break;
      const p = head[cur];
      head[cur] = next[p];
      const lab = labels[p], k = lab - 1;
      const x = p % W, y = (p - x) / W;
      const kx = cx[k], ky = cy[k], R2 = reachK[k] * reachK[k], amp = excess ? excess[k] : -1;
      for ( let dy = -1; dy <= 1; ++dy )
      {
         const yy = y + dy;
         if ( yy < 0 || yy >= H ) continue;
         for ( let dx = -1; dx <= 1; ++dx )
         {
            const xx = x + dx;
            if ( (dx == 0 && dy == 0) || xx < 0 || xx >= W ) continue;
            const q = yy * W + xx, lq = labels[q];
            if ( lq != 0 && !(owner !== null && owner[lq - 1] == 1) ) continue;
            const v = L[q];
            if ( !(v > T) ) continue;
            const ex = xx + 0.5 - kx, ey = yy + 0.5 - ky, d2 = ex * ex + ey * ey;
            if ( d2 > R2 ) continue;
            if ( amp >= 0 && amp * Math.pow( 1 + d2 * invA2, -GATE_BETA ) < GATE_GAMMA * v ) continue;
            labels[q] = lab;
            const b = bucket( v );
            next[q] = head[b]; head[b] = q;
            if ( b > cur ) cur = b;
         }
      }
   }
}

// Subtracts the background (median) from L and determines the maximum and threshold T.
// minSignal > 0 replaces the automatic threshold (5 sigma, at least 1e-4 of the maximum).
function prepareLuma( L, minSignal )
{
   const N = L.length, est = estimateBackground( L, N );
   let Lmax = 0;
   for ( let i = 0; i < N; ++i )
   {
      const v = L[i] - est.bg;
      L[i] = v > 0 ? v : 0;
      if ( L[i] > Lmax ) Lmax = L[i];
   }
   if ( Lmax <= 0 )
      throw new Error( "The image is empty." );
   return {
      bg: est.bg, sigma: est.sigma, Lmax: Lmax,
      T: minSignal > 0 ? minSignal : Math.max( 5 * est.sigma, 1e-4 * Lmax, 1e-7 )
   };
}

// Image stars without a Gaia partner (pseudo-seeds): local maxima of L above PSEUDO_MIN * T.
// Only one pixel per plateau (the earlier one in reading order). Excluded are maxima in the
// exclusion zone around every Gaia seed (core plateau, rings, spikes; radius grows with
// brightness) and all maxima from OWNER_FRAC * Lmax: pseudo-seeds never own a halo.
const PSEUDO_MIN = 6;
function findPseudoPeaks( L, W, H, gaiaPix, gaiaPeak, T, Lmax, fwhm )
{
   const excl = new Uint8Array( W * H ), thr = PSEUDO_MIN * T, out = [];
   for ( let k = 0; k < gaiaPix.length; ++k )
   {
      const x0 = gaiaPix[k] % W, y0 = (gaiaPix[k] - x0) / W;
      const R = Math.max( 3, 2.5 * fwhm ) * Math.max( 1, Math.log10( gaiaPeak[k] / T ) / 2 ), R2 = R * R;
      for ( let dy = -Math.floor( R ); dy <= Math.floor( R ); ++dy )
      {
         const y = y0 + dy;
         if ( y < 0 || y >= H ) continue;
         for ( let dx = -Math.floor( R ); dx <= Math.floor( R ); ++dx )
         {
            const x = x0 + dx;
            if ( x >= 0 && x < W && dx * dx + dy * dy <= R2 ) excl[y * W + x] = 1;
         }
      }
   }
   const top = OWNER_FRAC * Lmax;
   for ( let y = 1; y < H - 1; ++y )
      for ( let x = 1, i = y * W + 1; x < W - 1; ++x, ++i )
      {
         const v = L[i];
         if ( v < thr || v >= top || excl[i] ) continue;
         if ( v <= L[i - 1] || v <= L[i - W - 1] || v <= L[i - W] || v <= L[i - W + 1] ) continue;
         if ( v < L[i + 1] || v < L[i + W - 1] || v < L[i + W] || v < L[i + W + 1] ) continue;
         out.push( i );
      }
   return Int32Array.from( out );
}

// Color features of the seeds from the original channels 0,1,2 (e.g. S,H,O): sum over 3x3
// around the maximum (background subtracted per channel), feat[2k] = log10(channel2/channel1),
// feat[2k+1] = log10(channel0/channel1). NaN when saturated (>= 0.98), at the border or if a
// channel is not positive.
function seedFeatures( readRows, W, H, pix )
{
   const n = pix.length, feat = new Float32Array( 2 * n ).fill( NaN ), STRIP = 256;
   const bg = [0, 0, 0];
   if ( H >= 8 * 32 )
      for ( let c = 0; c < 3; ++c )
      {
         const buf = new Float32Array( W * 32 ), vals = [];
         for ( let q = 0; q < 8; ++q )
         {
            const y0 = Math.floor( (H - 32) * q / 7 );
            readRows( c, y0, y0 + 32, buf );
            for ( let i = 0; i < buf.length; i += 7 ) vals.push( buf[i] );
         }
         bg[c] = medianOf( vals );
      }
   const idx = Array.from( { length: n }, ( _, i ) => i ).sort( ( a, b ) => pix[a] - pix[b] );
   let ptr = 0, bufs = null, bufLen = -1;
   for ( let y0 = 0; y0 < H && ptr < n; y0 += STRIP )
   {
      const y1 = Math.min( H, y0 + STRIP ), ya = Math.max( 0, y0 - 1 ), yb = Math.min( H, y1 + 1 );
      const len = (yb - ya) * W;
      if ( len != bufLen )
      {
         bufs = [new Float32Array( len ), new Float32Array( len ), new Float32Array( len )];
         bufLen = len;
      }
      for ( let c = 0; c < 3; ++c ) readRows( c, ya, yb, bufs[c] );
      while ( ptr < n && pix[idx[ptr]] < y1 * W )
      {
         const k = idx[ptr++], x = pix[k] % W, y = (pix[k] - x) / W;
         if ( x < 1 || y < 1 || x >= W - 1 || y >= H - 1 ) continue;
         const sum = [0, 0, 0];
         let sat = false;
         for ( let dy = -1; dy <= 1; ++dy )
            for ( let dx = -1; dx <= 1; ++dx )
            {
               const o = (y + dy - ya) * W + x + dx;
               for ( let c = 0; c < 3; ++c )
               {
                  const v = bufs[c][o];
                  if ( v >= 0.98 ) sat = true;
                  sum[c] += v - bg[c];
               }
            }
         if ( sat || sum[0] <= 0 || sum[1] <= 0 || sum[2] <= 0 ) continue;
         feat[2*k] = Math.log10( sum[2] / sum[1] );
         feat[2*k + 1] = Math.log10( sum[0] / sum[1] );
      }
   }
   return feat;
}

// BP-RP = a + b*x + c*y (x, y = features) by least squares, with outlier rejection (3 sigma).
// sel: seed indices of the training stars, tv: BP-RP per seed. null if there is not enough data.
function fitColorModel( feat, tv, sel )
{
   let use = sel, fit = null;
   for ( let it = 0; it < 4 && use.length >= 30; ++it )
   {
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, st = 0, sxt = 0, syt = 0;
      for ( const k of use )
      {
         const x = feat[2*k], y = feat[2*k + 1], t = tv[k];
         ++n; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; st += t; sxt += x * t; syt += y * t;
      }
      const det = n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
      if ( !(Math.abs( det ) > 1e-12) ) return null;
      const a = (st * (sxx * syy - sxy * sxy) - sx * (sxt * syy - sxy * syt) + sy * (sxt * sxy - sxx * syt)) / det;
      const b = (n * (sxt * syy - sxy * syt) - st * (sx * syy - sxy * sy) + sy * (sx * syt - sxt * sy)) / det;
      const c = (n * (sxx * syt - sxt * sxy) - sx * (sx * syt - sxt * sy) + st * (sx * sxy - sxx * sy)) / det;
      const res = use.map( k => tv[k] - (a + b * feat[2*k] + c * feat[2*k + 1]) );
      const sigma = 1.4826 * medianOf( res.map( Math.abs ) );
      let ss = 0, mean = st / n, tot = 0;
      for ( let q = 0; q < use.length; ++q ) { ss += res[q] * res[q]; tot += (tv[use[q]] - mean) ** 2; }
      fit = { a: a, b: b, c: c, sigma: sigma, n: n, r2: tot > 0 ? 1 - ss / tot : 0 };
      use = use.filter( ( k, q ) => Math.abs( res[q] ) <= 3 * Math.max( sigma, 0.02 ) );
   }
   return fit;
}

const MODEL_MIN_R2 = 0.2, MODEL_MIN_STARS = 100;
function predictBpRp( m, fx, fy )
{
   const t = m.a + m.b * fx + m.c * fy;
   return t < -0.25 ? -0.25 : (t > 2.8 ? 2.8 : t);
}

// Matches Gaia stars to the image stars and distributes the pixels (watershed).
// gaia: { n, x, y, g, c } (c = BP-RP or NaN), opts: { win, reach, guess }.
// log: { info(text), warn(text) }. Throws on an implausible match.
// readRows( c, y0, y1, buf ): reads rows y0..y1-1 of channel c (only for opts.guess, otherwise null).
function assignStars( L, W, H, gaia, lut, prep, opts, log, readRows )
{
   const T = prep.T, Lmax = prep.Lmax, N = W * H;
   const order = new Uint32Array( gaia.n );
   for ( let i = 0; i < gaia.n; ++i ) order[i] = i;
   order.sort( ( a, b ) => gaia.g[a] - gaia.g[b] );

   const off = estimateOffset( L, W, H, gaia.x, gaia.y, order, opts.win, 2 * T, Lmax );
   log.info( format( "Offset image - Gaia: dx=%+.2f dy=%+.2f px (from %d stars, spread %.2f px)",
                     off.dx, off.dy, off.n, off.spread ) );
   if ( off.n >= 20 && off.spread > 1.0 )
      log.warn( "The Gaia positions only match roughly (spread > 1 px). Check the plate solution." );
   if ( Math.hypot( off.dx, off.dy ) > 2 )
      log.warn( "Large position offset - the plate solution may belong to a different image." );

   const seeds = findSeeds( L, W, H, gaia.x, gaia.y, order, off.dx, off.dy, opts.win, 2 * T );

   // Check: fraction of bright Gaia stars that have a maximum in the image
   const inner = i => gaia.x[i] > 20 && gaia.y[i] > 20 && gaia.x[i] < W - 20 && gaia.y[i] < H - 20;
   let gCheck = 0, nCheck = 0;
   for ( const gl of [13, 14, 15, 16, 17] )
   {
      nCheck = 0;
      for ( let i = 0; i < gaia.n; ++i )
         if ( gaia.g[i] <= gl && inner( i ) ) ++nCheck;
      gCheck = gl;
      if ( nCheck >= 30 ) break;
   }
   let nHit = 0;
   for ( let k = 0; k < seeds.n; ++k )
      if ( gaia.g[seeds.star[k]] <= gCheck && inner( seeds.star[k] ) ) ++nHit;
   const rate = nCheck > 0 ? nHit / nCheck : 0;
   log.info( format( "%d Gaia stars found in the image (of which G <= %d: %d of %d = %.0f%%).",
                     seeds.n, gCheck, nHit, nCheck, 100 * rate ) );
   if ( nCheck >= 30 )
   {
      if ( rate < 0.25 )
         throw new Error( format( "Only %.0f%% of the bright Gaia stars lie on image stars. The astrometric " +
                                  "solution does not match this image (or the image is not a star image).", 100 * rate ) );
      if ( rate < 0.6 )
         log.warn( "Fewer than 60% of the bright Gaia stars were found - check the result." );
   }
   if ( seeds.n < 10 )
      throw new Error( "Fewer than 10 Gaia stars could be matched in the image." );

   // --- Seeds: Gaia stars (first) and image stars without a Gaia partner (pseudo-seeds) ---------
   const nG = seeds.n;
   const peakG = new Float32Array( nG ), cxG = new Float32Array( nG ), cyG = new Float32Array( nG );
   for ( let k = 0; k < nG; ++k )
   {
      peakG[k] = L[seeds.pix[k]];
      cxG[k] = gaia.x[seeds.star[k]] + off.dx;
      cyG[k] = gaia.y[seeds.star[k]] + off.dy;
   }
   const fwhm = estimateFWHM( L, W, H, seeds.pix, peakG, T, Lmax );
   const alpha = fwhm / (2 * Math.sqrt( Math.pow( 2, 1 / GATE_BETA ) - 1 ));   // Moffat width for the FWHM

   const cand = findPseudoPeaks( L, W, H, seeds.pix, peakG, T, Lmax, fwhm );
   const pcx = new Float32Array( cand.length ), pcy = new Float32Array( cand.length ), ppk = new Float32Array( cand.length );
   for ( let c = 0; c < cand.length; ++c )
   {
      const x = cand[c] % W;
      pcx[c] = x + 0.5; pcy[c] = (cand[c] - x) / W + 0.5; ppk[c] = L[cand[c]];
   }
   const pex = seedExcess( L, W, H, pcx, pcy, ppk, new Uint8Array( cand.length ), fwhm );
   const keepP = [];
   for ( let c = 0; c < cand.length; ++c )
      if ( pex[c] >= PSEUDO_MIN * T ) keepP.push( c );   // stands out above the surrounding level, not noise
   const nP = keepP.length, nT = nG + nP;

   const pix = new Int32Array( nT ), peak = new Float32Array( nT );
   const seed = {
      cx: new Float32Array( nT ), cy: new Float32Array( nT ), col: new Float32Array( 3 * nT ),
      reach: new Float32Array( nT ), owner: new Uint8Array( nT ), excess: null, alpha: alpha
   };
   for ( let k = 0; k < nG; ++k )
   {
      pix[k] = seeds.pix[k]; peak[k] = peakG[k]; seed.cx[k] = cxG[k]; seed.cy[k] = cyG[k];
   }
   for ( let q = 0; q < nP; ++q )
   {
      const c = keepP[q], k = nG + q;
      pix[k] = cand[c]; peak[k] = ppk[c]; seed.cx[k] = pcx[c]; seed.cy[k] = pcy[c];
   }

   // --- Color: Gaia, otherwise estimated from the original color, otherwise neutral ------------
   const tv = new Float32Array( nG );
   for ( let k = 0; k < nG; ++k ) tv[k] = gaia.c[seeds.star[k]];
   const feat = (readRows && opts.guess) ? seedFeatures( readRows, W, H, pix ) : null;
   let model = null;
   if ( feat )
   {
      const sel = [];
      for ( let k = 0; k < nG; ++k )
         if ( !isNaN( tv[k] ) && isFinite( feat[2*k] ) && isFinite( feat[2*k + 1] ) &&
              peak[k] >= 30 * T && peak[k] <= 0.7 * Lmax )
            sel.push( k );
      const stride = Math.max( 1, Math.floor( sel.length / 40000 ) );
      const m = fitColorModel( feat, tv, sel.filter( ( k, i ) => i % stride == 0 ) );
      if ( m && m.n >= MODEL_MIN_STARS && m.r2 >= MODEL_MIN_R2 )
      {
         model = m;
         log.info( format( "Color model from %d stars: BP-RP = %.2f %+.2f*log(C3/C2) %+.2f*log(C1/C2), R2 = %.2f, scatter %.2f mag.",
                           m.n, m.a, m.b, m.c, m.r2, m.sigma ) );
      }
      else if ( !m || m.n < MODEL_MIN_STARS )
         log.warn( format( "Color model: only %d usable training stars (at least %d): stars without a Gaia color stay neutral.",
                           m ? m.n : sel.length, MODEL_MIN_STARS ) );
      else
         log.warn( format( "Color model too weak (R2 = %.2f, at least %.1f): stars without a Gaia color stay neutral.",
                           m.r2, MODEL_MIN_R2 ) );
   }
   let nNeutral = 0, nGuess = 0;
   for ( let k = 0; k < nT; ++k )
   {
      let c = k < nG ? tv[k] : NaN;
      if ( isNaN( c ) && model && isFinite( feat[2*k] ) && isFinite( feat[2*k + 1] ) )
      {
         c = predictBpRp( model, feat[2*k], feat[2*k + 1] );
         ++nGuess;
      }
      if ( isNaN( c ) )
      {
         seed.col[3*k] = seed.col[3*k + 1] = seed.col[3*k + 2] = 1;
         ++nNeutral;
      }
      else
      {
         const li = lutIndex( c );
         seed.col[3*k] = lut[3*li]; seed.col[3*k + 1] = lut[3*li + 1]; seed.col[3*k + 2] = lut[3*li + 2];
      }
   }

   // --- Owners, reach, own light, watershed in two stages ----------------------------------------
   const own = [], oth = [];
   for ( let k = 0; k < nT; ++k )
   {
      seed.owner[k] = peak[k] >= OWNER_FRAC * Lmax ? 1 : 0;
      (seed.owner[k] ? own : oth).push( k );
      // Reach grows with brightness: x1 up to 100 T, x3 from 10000 T
      let t = (Math.log10( peak[k] / T ) - 2) / 2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      seed.reach[k] = opts.reach * (1 + 2 * t * t * (3 - 2 * t));
   }
   log.info( format( "FWHM about %.1f px, %d bright stars own their halo, %d image stars without a Gaia partner.",
                     fwhm, own.length, nP ) );
   seed.excess = seedExcess( L, W, H, seed.cx, seed.cy, peak, seed.owner, fwhm );

   const labels = new Int32Array( N ), next = new Int32Array( N );
   floodLabels( L, W, H, labels, next, own, pix, seed.cx, seed.cy, null, alpha, seed.reach, null, T, Lmax );
   floodLabels( L, W, H, labels, next, oth, pix, seed.cx, seed.cy, seed.excess, alpha, seed.reach, seed.owner, T, Lmax );
   let nStar = 0, nLab = 0;
   for ( let i = 0; i < N; ++i )
   {
      if ( L[i] > T ) ++nStar;
      if ( labels[i] > 0 ) ++nLab;
   }
   return { seed: seed, peak: peak, labels: labels, nSeeds: nG, nPseudo: nP, neutralSeeds: nNeutral,
            nGuessed: nGuess, model: model, off: off, nStarPixels: nStar, nLabelled: nLab,
            seedStar: seeds.star, fwhm: fwhm, nOwners: own.length };
}

// Coloring factors (r,g,b, mean ~1) of a pixel from its label. At a distance of
// 0.7*reach .. reach from the star the Gaia color fades to neutral. Returns the weight w (0..1).
const labelCol = new Float64Array( 3 );
function labelFactors( lab, x, y, seed )
{
   labelCol[0] = labelCol[1] = labelCol[2] = 1;
   if ( lab <= 0 ) return 0;
   const k = lab - 1, reach = seed.reach[k], Rin = 0.7 * reach;
   const dx = x + 0.5 - seed.cx[k], dy = y + 0.5 - seed.cy[k], d2 = dx * dx + dy * dy;
   if ( d2 >= reach * reach ) return 0;
   const w = d2 <= Rin * Rin ? 1 : 0.5 * (1 + Math.cos( Math.PI * (Math.sqrt( d2 ) - Rin) / (reach - Rin) ));
   labelCol[0] = 1 + w * (seed.col[3*k] - 1);
   labelCol[1] = 1 + w * (seed.col[3*k + 1] - 1);
   labelCol[2] = 1 + w * (seed.col[3*k + 2] - 1);
   return w;
}

// Box filter (radius r, two passes) on a w*h grid, zero outside
function boxBlur2( a, w, h, r )
{
   const t = new Float32Array( a.length ), win = 2 * r + 1;
   for ( let pass = 0; pass < 2; ++pass )
   {
      for ( let y = 0; y < h; ++y )
      {
         let acc = 0;
         for ( let x = 0; x < r && x < w; ++x ) acc += a[y * w + x];
         for ( let x = 0; x < w; ++x )
         {
            if ( x + r < w ) acc += a[y * w + x + r];
            if ( x - r - 1 >= 0 ) acc -= a[y * w + x - r - 1];
            t[y * w + x] = acc / win;
         }
      }
      for ( let x = 0; x < w; ++x )
      {
         let acc = 0;
         for ( let y = 0; y < r && y < h; ++y ) acc += t[y * w + x];
         for ( let y = 0; y < h; ++y )
         {
            if ( y + r < h ) acc += t[(y + r) * w + x];
            if ( y - r - 1 >= 0 ) acc -= t[(y - r - 1) * w + x];
            a[y * w + x] = acc / win;
         }
      }
   }
}

// Soft color fields on a coarse grid (cell g px, blur with radius rb cells),
// brightness weighted. Two fields:
//   own: only from the light of the owners (halos of bright stars). Pure halo color per cell
//        and halo level lev (mean brightness of the owner light per pixel). Field stars in
//        the halo must not tint the halo color, otherwise gray fringes appear around them.
//   all: from all assigned light, only for unassigned pixels. Unassigned light counts with
//        UNL_WEIGHT in the denominator, the color fades to neutral there. Strength lam.
const UNL_WEIGHT = 0.15;
function buildSoftColors( L, W, H, labels, seed, g, rb )
{
   const gw = Math.ceil( W / g ), gh = Math.ceil( H / g ), n = gw * gh;
   const mk = () => new Float32Array( n );
   const slo = mk(), sro = mk(), sgo = mk(), sbo = mk();
   const sla = mk(), sra = mk(), sga = mk(), sba = mk(), su = mk();
   for ( let y = 0; y < H; ++y )
      for ( let x = 0, i = y * W; x < W; ++x, ++i )
      {
         const v = L[i];
         if ( v <= 0 ) continue;
         const c = ((y / g) | 0) * gw + ((x / g) | 0), lab = labels[i];
         if ( lab > 0 )
         {
            labelFactors( lab, x, y, seed );
            sla[c] += v; sra[c] += v * labelCol[0]; sga[c] += v * labelCol[1]; sba[c] += v * labelCol[2];
            if ( seed.owner[lab - 1] )
            {
               slo[c] += v; sro[c] += v * labelCol[0]; sgo[c] += v * labelCol[1]; sbo[c] += v * labelCol[2];
            }
         }
         else
            su[c] += v;
   }
   for ( const a of [slo, sro, sgo, sbo, sla, sra, sga, sba, su] ) boxBlur2( a, gw, gh, rb );
   const own = { r: mk(), gC: mk(), b: mk(), q: mk() }, all = { r: mk(), gC: mk(), b: mk(), q: mk() };
   for ( let c = 0; c < n; ++c )
   {
      if ( slo[c] > 1e-12 )
      {
         own.r[c] = sro[c] / slo[c]; own.gC[c] = sgo[c] / slo[c]; own.b[c] = sbo[c] / slo[c]; own.q[c] = slo[c] / (g * g);
      }
      else { own.r[c] = own.gC[c] = own.b[c] = 1; own.q[c] = 0; }
      const d = sla[c] + UNL_WEIGHT * su[c];
      if ( sla[c] > 1e-12 && d > 0 )
      {
         const lam = sla[c] / d;
         all.r[c] = 1 + lam * (sra[c] / sla[c] - 1);
         all.gC[c] = 1 + lam * (sga[c] / sla[c] - 1);
         all.b[c] = 1 + lam * (sba[c] / sla[c] - 1);
         all.q[c] = lam;
      }
      else { all.r[c] = all.gC[c] = all.b[c] = 1; all.q[c] = 0; }
   }
   return { g: g, gw: gw, gh: gh, own: own, all: all };
}

// Bilinear from a field (r, gC, b, q) at pixel (x, y); result in softOut[0..3]
const softOut = new Float64Array( 4 );
function sampleSoft( grid, soft, x, y )
{
   const gs = soft.g, u = (x + 0.5) / gs - 0.5, v = (y + 0.5) / gs - 0.5;
   let i0 = Math.floor( u ), j0 = Math.floor( v );
   const fu = u - i0, fv = v - j0;
   const i1 = Math.min( soft.gw - 1, i0 + 1 ), j1 = Math.min( soft.gh - 1, j0 + 1 );
   i0 = Math.max( 0, i0 ); j0 = Math.max( 0, j0 );
   const a = j0 * soft.gw + i0, b = j0 * soft.gw + i1, c = j1 * soft.gw + i0, d = j1 * soft.gw + i1;
   const m00 = (1 - fu) * (1 - fv), m10 = fu * (1 - fv), m01 = (1 - fu) * fv, m11 = fu * fv;
   softOut[0] = m00 * grid.r[a] + m10 * grid.r[b] + m01 * grid.r[c] + m11 * grid.r[d];
   softOut[1] = m00 * grid.gC[a] + m10 * grid.gC[b] + m01 * grid.gC[c] + m11 * grid.gC[d];
   softOut[2] = m00 * grid.b[a] + m10 * grid.b[b] + m01 * grid.b[c] + m11 * grid.b[d];
   softOut[3] = m00 * grid.q[a] + m10 * grid.q[b] + m01 * grid.q[c] + m11 * grid.q[d];
}

// Recolors rows y0 .. y0+rows-1. L: brightness without background (>= 0), seed: center, reach,
// color (r,g,b with mean 1), owner flag, own light; peak: peak value per seed.
//  - Pixels of an owner (bright star) below 2 % of its peak (fully from 0.2 %) take the halo
//    color from soft.own (smooth, without influence of the field stars).
//  - Pixels of a field star: fraction f of its modeled own light in the pixel, the rest of the
//    pixel light is halo (level from soft.own) and gets the halo color. Light adds up.
//  - Unassigned pixels: color from soft.all, strength lam (w).
// src: original channels of the strip or null; then the coloring blends to the original by w.
const RHO_LOG_HI = Math.log10( 0.02 );
function colorizeStrip( W, y0, rows, L, labels, bg, seed, peak, soft, src, outR, outG, outB, wOut )
{
   const n = W * rows, base = y0 * W, invA2 = 1 / (seed.alpha * seed.alpha);
   for ( let j = 0; j < n; ++j )
   {
      const i = base + j, lab = labels[i], lw = L[i], x = j % W, y = y0 + (j - x) / W;
      let w = labelFactors( lab, x, y, seed );
      let cr = labelCol[0], cg = labelCol[1], cb = labelCol[2];
      if ( soft && lw > 0 )
      {
         if ( lab > 0 )
         {
            const k = lab - 1;
            if ( seed.owner[k] )
            {
               const rho = lw / peak[k];
               if ( rho < 0.02 )
               {
                  let t = RHO_LOG_HI - Math.log10( rho );   // 0 at 2 %, 1 at 0.2 %
                  t = t < 0 ? 0 : (t > 1 ? 1 : t);
                  const sm = t * t * (3 - 2 * t);
                  sampleSoft( soft.own, soft, x, y );
                  cr += sm * (softOut[0] - cr); cg += sm * (softOut[1] - cg); cb += sm * (softOut[2] - cb);
               }
            }
            else
            {
               const dx = x + 0.5 - seed.cx[k], dy = y + 0.5 - seed.cy[k];
               const own = seed.excess[k] * Math.pow( 1 + (dx * dx + dy * dy) * invA2, -GATE_BETA );
               const f = own >= lw ? 1 : own / lw;
               if ( f < 1 )
               {
                  sampleSoft( soft.own, soft, x, y );
                  const m = Math.min( 1 - f, softOut[3] / lw );   // fraction of the halo in the pixel light
                  if ( m > 0 )
                  {
                     cr += m * (softOut[0] - cr); cg += m * (softOut[1] - cg); cb += m * (softOut[2] - cb);
                  }
               }
            }
         }
         else
         {
            sampleSoft( soft.all, soft, x, y );
            cr = softOut[0]; cg = softOut[1]; cb = softOut[2]; w = softOut[3];
         }
      }
      let r = bg + lw * cr, g = bg + lw * cg, b = bg + lw * cb;
      const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if ( m > 1 )
      {
         // Gamut: desaturate towards the center until the maximum reaches 1 (cores -> white)
         const gray = (r + g + b) / 3;
         if ( gray >= 1 )
            r = g = b = 1;
         else
         {
            const t = (m - 1) / (m - gray);
            r += t * (gray - r); g += t * (gray - g); b += t * (gray - b);
         }
      }
      if ( src )
      {
         r = w * r + (1 - w) * src[0][j];
         g = w * g + (1 - w) * src[1][j];
         b = w * b + (1 - w) * src[2][j];
      }
      outR[j] = r < 0 ? 0 : (r > 1 ? 1 : r);
      outG[j] = g < 0 ? 0 : (g > 1 ? 1 : g);
      outB[j] = b < 0 ? 0 : (b > 1 ? 1 : b);
      if ( wOut ) wOut[j] = w;
   }
}
// ==== END CORE ====

// ------------------------------ Parameters ----------------------------------
const P = {
   catalog:    0,       // 0 = Gaia DR3 local (XPSD), 1 = Gaia DR3 online (VizieR)
   magMax:     19,      // Gaia G, fainter stars are not loaded
   lumaMode:   0,       // 0 = mean of the channels, 1 = maximum
   whiteRef:   0,       // 0 = Sun (G2V) neutral, 1 = blackbody in sRGB (D65)
   saturation: 1.0,
   unmatched:  0,       // 0 = neutral, 1 = keep original
   win:        3.0,     // search window around the Gaia position in pixels
   reach:      120,     // reach of a faint star in pixels, bright ones up to three times
   minSignal:  0,       // 0 = automatic
   guess:      true,    // estimate the color of stars without a Gaia color from the original color
   makeMask:   false
};

function loadSettings()
{
   const num = ( name, lo, hi ) => {
      const v = Settings.read( GSC_KEY + name, DataType.Double );
      if ( Settings.lastReadOK && isFinite( v ) && v >= lo && v <= hi )
         P[name] = v;
   };
   num( "catalog", 0, 1 );        P.catalog = Math.round( P.catalog );
   num( "magMax", 5, 22 );
   num( "lumaMode", 0, 1 );       P.lumaMode = Math.round( P.lumaMode );
   num( "whiteRef", 0, 1 );       P.whiteRef = Math.round( P.whiteRef );
   num( "saturation", 0, 3 );
   num( "unmatched", 0, 1 );      P.unmatched = Math.round( P.unmatched );
   num( "win", 1, 10 );
   num( "reach", 10, 1000 );
   num( "minSignal", 0, 1 );
   for ( const name of ["guess", "makeMask"] )
   {
      const b = Settings.read( GSC_KEY + name, DataType.Boolean );
      if ( Settings.lastReadOK )
         P[name] = b;
   }
}

function saveSettings()
{
   for ( const name of ["catalog", "magMax", "lumaMode", "whiteRef", "saturation",
                        "unmatched", "win", "reach", "minSignal"] )
      Settings.write( GSC_KEY + name, DataType.Double, P[name] );
   Settings.write( GSC_KEY + "guess", DataType.Boolean, P.guess );
   Settings.write( GSC_KEY + "makeMask", DataType.Boolean, P.makeMask );
}

// ------------------------------- Helper functions ----------------------------
function fmtTime( sec )
{
   sec = Math.round( sec );
   const h = Math.floor( sec / 3600 ), m = Math.floor( (sec % 3600) / 60 ), s = sec % 60;
   return (h > 0 ? h + "h " : "") + m + "m " + s + "s";
}

function checkAbort( what )
{
   CoreApplication.processEvents();
   if ( console.abortRequested )
      throw new Error( "Aborted (" + what + ")." );
}

function readLuma( img, W, H, C, mode )
{
   const L = new Float32Array( W * H );
   const rows = Math.max( 1, Math.floor( 4000000 / W ) );
   let buf = new Float32Array( W * rows );
   for ( let c = 0; c < C; ++c )
      for ( let y0 = 0; y0 < H; y0 += rows )
      {
         const y1 = Math.min( H, y0 + rows ), cnt = (y1 - y0) * W, base = y0 * W;
         if ( buf.length != cnt )
            buf = new Float32Array( cnt );
         img.getSamples( buf, new Rect( 0, y0, W, y1 ), c );
         if ( mode == 1 && c > 0 )
            for ( let j = 0; j < cnt; ++j )
               { if ( buf[j] > L[base + j] ) L[base + j] = buf[j]; }
         else
            for ( let j = 0; j < cnt; ++j )
               L[base + j] += buf[j];
      }
   if ( mode == 0 && C > 1 )
      for ( let i = 0; i < L.length; ++i )
         L[i] /= C;
   return L;
}

function gaiaXpsdAvailable()
{
   return typeof( Gaia ) != "undefined";
}

// Loads Gaia DR3 for the image field and returns pixel positions, G and BP-RP
function loadGaiaStars( metadata, W, H )
{
   const online = P.catalog == 1;
   if ( !online && !gaiaXpsdAvailable() )
      throw new Error( "The Gaia process (XPSD) is not installed. Choose 'Gaia DR3 (online, VizieR)' in the dialog." );

   const catalog = CatalogRegistry.newCatalog( online ? "GaiaDR3" : "GaiaDR3_XPSD" );
   if ( catalog === null )
      throw new Error( "Gaia DR3 catalog not found." );
   catalog.magMax = P.magMax;
   catalog.reportObjectsInside = false;
   if ( online )
      catalog.maxRecords = 3000000;

   if ( !metadata.observationTime )
   {
      console.warningln( "No observation time in the image header (DATE-OBS): proper motion is not corrected." );
      metadata.observationTime = 2457389.0;   // Gaia epoch J2016.0
   }

   console.writeln( "Loading ", catalog.name, " (G <= ", format( "%.1f", P.magMax ), ") ..." );
   CoreApplication.processEvents();
   try
   {
      catalog.Load( metadata, "https://vizier.cds.unistra.fr/" );
   }
   catch ( e )
   {
      throw new Error( "Gaia query failed: " + (e.message || e) +
         (online ? "" : " (Is the Gaia DR3 database set up in the Gaia process configuration?)") );
   }
   const objs = catalog.objects;
   if ( objs === null || objs === undefined || objs.length == 0 )
      throw new Error( "The catalog returned no stars for this image field." );
   console.writeln( format( "%d Gaia entries in the search circle.", objs.length ) );

   const xs = [], ys = [], gs = [], cs = [];
   let noColor = 0;
   const T = new ElapsedTime;
   for ( let i = 0; i < objs.length; ++i )
   {
      const o = objs[i];
      if ( !o ) continue;
      const p = metadata.Convert_RD_I( o.posRD );
      if ( p && p.x >= -1 && p.y >= -1 && p.x <= W + 1 && p.y <= H + 1 )
      {
         const g = parseFloat( o["Gmag"] );
         const bp = parseFloat( o["BPmag"] ), rp = parseFloat( o["RPmag"] );
         const flags = o["Flags"] ? parseInt( o["Flags"], 16 ) : 0;
         // Flags 0x2 / 0x4: no BP / RP magnitude (Gaia XPSD)
         const ok = isFinite( bp ) && isFinite( rp ) && bp < 40 && rp < 40 && (flags & 6) == 0;
         if ( !ok ) ++noColor;
         xs.push( p.x ); ys.push( p.y );
         gs.push( isFinite( g ) ? g : 30 );
         cs.push( ok ? bp - rp : NaN );
      }
      if ( T.value > 0.5 )
      {
         console.write( format( "<end><clrbol>Converting to pixels: %.0f%%", 100 * i / objs.length ) );
         checkAbort( "while converting the star positions" );
         T.reset();
      }
   }
   console.writeln( "<end><clrbol>" );
   return {
      n: xs.length, noColor: noColor, catalogName: catalog.name,
      x: Float32Array.from( xs ), y: Float32Array.from( ys ),
      g: Float32Array.from( gs ), c: Float32Array.from( cs )
   };
}

// Creates the result window and puts it into a process so that the content can be
// written directly (no intermediate image in memory).
function newResultWindow( id, W, H, nChannels )
{
   const w = new ImageWindow( W, H, nChannels, 32, true, nChannels == 3, id );
   w.mainView.beginProcess( UndoFlag.NoSwapFile );
   return w;
}

// sourceWindow: source window whose astrometric solution and header data are copied
function finishResultWindow( w, sourceWindow, metadata )
{
   if ( sourceWindow )
   {
      metadata.SaveProperties( w, "GaiaStarColors " + GSC_VERSION );
      w.keywords = sourceWindow.keywords;
   }
   w.mainView.endProcess();
   if ( sourceWindow )
      w.regenerateAstrometricSolution();
   w.show();
}

// Transfers the screen transfer function (STF) of the source view to the result view.
// View.stf holds [midtones, shadows, highlights, r0, r1] per channel on both sides, so it
// can be assigned directly. (The ScreenTransferFunction process uses another parameter
// order, [shadows, highlights, midtones, r0, r1]; passing View.stf to it swaps the values.)
function copySTF( srcView, dstView )
{
   try
   {
      dstView.stf = srcView.stf;
   }
   catch ( e )
   {
      console.warningln( "Could not transfer the STF: " + (e.message || e) );
      return;
   }
   try { dstView.window.regenerate(); } catch ( e ) {}   // refresh the screen rendition
}

// ------------------------------- Dialog -------------------------------------
const GSCDialog = class extends Dialog
{
   constructor( info )
   {
      super();
      const self = this;
      const labelWidth = this.font.width( "Min. signal (0 = auto):" ) + 8;

      this.windowTitle = "Gaia Star Colors";

      this.helpLabel = new Label( this );
      this.helpLabel.frameStyle = FrameStyle.Box;
      this.helpLabel.margin = 6;
      this.helpLabel.wordWrapping = true;
      this.helpLabel.useRichText = true;
      this.helpLabel.text =
         "<b>Gaia Star Colors " + GSC_VERSION + "</b><br>Recolors a star image (e.g. SHO stars without background) " +
         "with Gaia colors to produce RGB stars. The brightness stays from the image. " +
         "The image must be plate solved.";

      this.infoLabel = new Label( this );
      this.infoLabel.frameStyle = FrameStyle.Box;
      this.infoLabel.margin = 6;
      this.infoLabel.wordWrapping = true;
      this.infoLabel.useRichText = true;
      this.infoLabel.text = info;

      const mkCombo = ( text, items, current, onSel, tip ) => {
         const label = new Label( this );
         label.text = text;
         label.minWidth = labelWidth;
         label.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
         const combo = new ComboBox( this );
         for ( const it of items )
            combo.addItem( it );
         combo.currentItem = current;
         combo.onItemSelected = onSel;
         combo.toolTip = tip;
         const sizer = new HorizontalSizer;
         sizer.spacing = 6;
         sizer.add( label );
         sizer.add( combo, 100 );
         return sizer;
      };

      const mkEdit = ( text, lo, hi, prec, value, onVal, tip ) => {
         const e = new NumericEdit( this );
         e.label.text = text;
         e.label.minWidth = labelWidth;
         e.setReal( true );
         e.setRange( lo, hi );
         e.setPrecision( prec );
         e.setValue( value );
         e.toolTip = tip;
         e.onValueUpdated = onVal;
         return e;
      };

      this.catalogSizer = mkCombo( "Gaia source:",
         ["Gaia DR3 (local, XPSD)", "Gaia DR3 (online, VizieR)"], P.catalog,
         i => { P.catalog = i; },
         "XPSD is PixInsight's local database (as used by PCC), VizieR needs internet and is slower." );

      this.magEdit = mkEdit( "Gaia G max:", 8, 21, 1, P.magMax, v => { P.magMax = v; },
         "Fainter Gaia stars are not loaded. Too high makes the conversion slow, too low leaves " +
         "bright image stars uncolored. 18.5 to 19.5 suits most images." );

      this.lumaSizer = mkCombo( "Brightness from:",
         ["Mean of the channels", "Maximum of the channels"], P.lumaMode,
         i => { P.lumaMode = i; },
         "The brightness of a star pixel comes from the narrowband channels, the color comes from Gaia." );

      this.whiteSizer = mkCombo( "White balance:",
         ["Sun (G2V) = neutral", "Blackbody in sRGB (D65)"], P.whiteRef,
         i => { P.whiteRef = i; },
         "Sun neutral corresponds to the PCC white balance with a G2V reference; stars like the Sun become white." );

      this.satControl = new NumericControl( this );
      this.satControl.label.text = "Saturation:";
      this.satControl.label.minWidth = labelWidth;
      this.satControl.setRange( 0, 3 );
      this.satControl.slider.setRange( 0, 300 );
      this.satControl.setPrecision( 2 );
      this.satControl.setValue( P.saturation );
      this.satControl.toolTip = "1 = Gaia colors unchanged. In stretched star images the colors look " +
         "stronger than in linear ones; then set it below 1.";
      this.satControl.onValueUpdated = v => { P.saturation = v; };

      this.unmatchedSizer = mkCombo( "Unassigned:",
         ["Neutral (brightness as gray)", "Keep original colors"], P.unmatched,
         i => { P.unmatched = i; },
         "Pixels that are not assigned to any Gaia star (distant halos, stars without a Gaia entry, leftovers)." );

      this.winEdit = mkEdit( "Search window (px):", 1, 10, 1, P.win, v => { P.win = v; },
         "Radius around the Gaia position in which the brightness maximum of the star is searched." );

      this.reachEdit = mkEdit( "Reach (px):", 10, 1000, 0, P.reach, v => { P.reach = v; },
         "Maximum distance of a pixel from its star. Applies to faint stars, very bright stars reach up " +
         "to three times as far (their halos). Limits how far halos and spikes are colored and protects " +
         "nebula remnants in the star image." );

      this.signalEdit = mkEdit( "Min. signal (0 = auto):", 0, 1, 6, P.minSignal, v => { P.minSignal = v; },
         "Threshold from which a pixel belongs to a star (in image values, 0..1). 0 = automatic from " +
         "noise and image maximum." );

      this.guessCheck = new CheckBox( this );
      this.guessCheck.text = "Estimate color of stars without a Gaia entry from the original color";
      this.guessCheck.checked = P.guess;
      this.guessCheck.toolTip = "From the stars with a Gaia color the script learns how the color ratios of the " +
         "narrowband channels (e.g. O/H, S/H) translate into BP-RP. Image stars without a Gaia partner and " +
         "Gaia stars without BP/RP then get an estimated color. If the relation is too weak (R2 < 0.2) they " +
         "stay neutral. Needs an image with at least three channels.";
      this.guessCheck.onClick = c => { P.guess = c; };

      this.maskCheck = new CheckBox( this );
      this.maskCheck.text = "Create assignment mask";
      this.maskCheck.checked = P.makeMask;
      this.maskCheck.toolTip = "Additional image with the Gaia weight per pixel (1 = fully Gaia, 0 = neutral/original).";
      this.maskCheck.onClick = c => { P.makeMask = c; };

      this.okButton = new PushButton( this );
      this.okButton.text = "Start";
      this.okButton.defaultButton = true;
      this.okButton.onClick = () => { self.ok(); };

      this.cancelButton = new PushButton( this );
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = () => { self.cancel(); };

      this.buttonSizer = new HorizontalSizer;
      this.buttonSizer.spacing = 6;
      this.buttonSizer.addStretch();
      this.buttonSizer.add( this.okButton );
      this.buttonSizer.add( this.cancelButton );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 6;
      this.sizer.add( this.helpLabel );
      this.sizer.add( this.infoLabel );
      this.sizer.add( this.catalogSizer );
      this.sizer.add( this.magEdit );
      this.sizer.add( this.lumaSizer );
      this.sizer.add( this.whiteSizer );
      this.sizer.add( this.satControl );
      this.sizer.add( this.unmatchedSizer );
      this.sizer.add( this.winEdit );
      this.sizer.add( this.reachEdit );
      this.sizer.add( this.signalEdit );
      this.sizer.add( this.guessCheck );
      this.sizer.add( this.maskCheck );
      this.sizer.addSpacing( 4 );
      this.sizer.add( this.buttonSizer );

      this.ensureLayoutUpdated();
      this.adjustToContents();
   }
};

// ------------------------------- Main run -----------------------------------
function main()
{
   console.show();
   console.abortEnabled = true;

   const win = ImageWindow.activeWindow;
   if ( win.isNull )
      throw new Error( "No image is active." );
   const id = win.mainView.id;
   const src = win.mainView.image;
   const W = src.width, H = src.height, C = src.numberOfChannels;

   const metadata = new AstrometricMetadata( "GaiaStarColors" );
   metadata.ExtractMetadata( win );
   if ( !metadata.ref_I_G )
      throw new Error( "The image '" + id + "' has no astrometric solution. Solve it with ImageSolver first." );

   loadSettings();
   const info = format( "Image <b>%s</b>: %d x %d, %d channel(s), %.2f \"/px<br>Observation time in header: %s &nbsp;|&nbsp; " +
                        "Gaia XPSD in PixInsight: %s",
                        id, W, H, C, metadata.resolution * 3600,
                        metadata.observationTime ? "yes" : "no (proper motion uncorrected)",
                        gaiaXpsdAvailable() ? "yes" : "no (choose online)" );
   if ( !gaiaXpsdAvailable() )
      P.catalog = 1;
   const dlg = new GSCDialog( info );
   if ( !dlg.execute() )
      return;
   saveSettings();

   const t0 = Date.now();
   console.writeln( format( "<b>Gaia Star Colors %s</b>: %s, %dx%d", GSC_VERSION, id, W, H ) );

   // ---- Load Gaia ----------------------------------------------------------
   const gaia = loadGaiaStars( metadata, W, H );
   console.writeln( format( "%d Gaia stars in the image, %d of them without BP/RP color.", gaia.n, gaia.noColor ) );
   if ( gaia.n < 50 )
      throw new Error( "Too few Gaia stars in the image field (" + gaia.n + ") - is the astrometric solution correct?" );

   // ---- Brightness ---------------------------------------------------------
   console.writeln( "Reading brightness ..." );
   CoreApplication.processEvents();
   const L = readLuma( src, W, H, C, P.lumaMode );
   const prep = prepareLuma( L, P.minSignal );
   console.writeln( format( "Background %.6f, noise %.6f, maximum %.4f -> threshold %.6f",
                            prep.bg, prep.sigma, prep.Lmax, prep.T ) );
   checkAbort( "after reading" );

   // ---- Matching and watershed ---------------------------------------------
   console.writeln( "Matching Gaia stars and distributing pixels ..." );
   CoreApplication.processEvents();
   const lut = buildColorLUT( P.whiteRef == 0, P.saturation );
   const log = { info: t => console.writeln( t ), warn: t => console.warningln( t ) };
   const readRows = C >= 3 ? ( c, ya, yb, buf ) => src.getSamples( buf, new Rect( 0, ya, W, yb ), c ) : null;
   const A = assignStars( L, W, H, gaia, lut, prep, { win: P.win, reach: P.reach, guess: P.guess }, log, readRows );
   console.writeln( format( "%d Gaia seeds + %d image stars without Gaia: color estimated for %d, neutral for %d; %.1f%% of the star pixels assigned.",
                            A.nSeeds, A.nPseudo, A.nGuessed, A.neutralSeeds,
                            A.nStarPixels > 0 ? 100 * A.nLabelled / A.nStarPixels : 0 ) );
   checkAbort( "after the watershed" );
   const labels = A.labels, seed = A.seed;
   const soft = buildSoftColors( L, W, H, labels, seed, 4, 4 );

   // ---- Recolor ------------------------------------------------------------
   console.writeln( "Recoloring ..." );
   CoreApplication.processEvents();
   const rows = Math.max( 1, Math.floor( 2000000 / W ) );
   const keepOrig = P.unmatched == 1 && C >= 3;
   let outW = null, maskW = null;
   try
   {
      outW = newResultWindow( id + "_RGB", W, H, 3 );
      maskW = P.makeMask ? newResultWindow( id + "_gmask", W, H, 1 ) : null;
      const out = outW.mainView.image, mask = maskW ? maskW.mainView.image : null;
      let outR = new Float32Array( W * rows ), outG = new Float32Array( W * rows ), outB = new Float32Array( W * rows );
      let wOut = mask ? new Float32Array( W * rows ) : null;
      let srcB = keepOrig ? [new Float32Array( W * rows ), new Float32Array( W * rows ), new Float32Array( W * rows )] : null;
      for ( let y0 = 0; y0 < H; y0 += rows )
      {
         const y1 = Math.min( H, y0 + rows ), cnt = (y1 - y0) * W, rect = new Rect( 0, y0, W, y1 );
         if ( outR.length != cnt )
         {
            outR = new Float32Array( cnt ); outG = new Float32Array( cnt ); outB = new Float32Array( cnt );
            if ( wOut ) wOut = new Float32Array( cnt );
            if ( srcB ) srcB = [new Float32Array( cnt ), new Float32Array( cnt ), new Float32Array( cnt )];
         }
         if ( srcB )
            for ( let c = 0; c < 3; ++c )
               src.getSamples( srcB[c], rect, c );
         colorizeStrip( W, y0, y1 - y0, L, labels, prep.bg, seed, A.peak, soft, srcB, outR, outG, outB, wOut );
         out.setSamples( outR, rect, 0 );
         out.setSamples( outG, rect, 1 );
         out.setSamples( outB, rect, 2 );
         if ( mask ) mask.setSamples( wOut, rect, 0 );
         checkAbort( "while recoloring" );
      }
      finishResultWindow( outW, win, metadata );
      copySTF( win.mainView, outW.mainView );
      if ( maskW )
         finishResultWindow( maskW, null, null );
   }
   catch ( e )
   {
      for ( const w of [outW, maskW] )
         if ( w !== null )
         {
            try { w.mainView.endProcess(); } catch ( e2 ) {}
            try { w.forceClose(); } catch ( e2 ) {}
         }
      throw e;
   }

   console.writeln( "<b>Done</b> in " + fmtTime( (Date.now() - t0) / 1000 ) + ": " + outW.mainView.id );
}

try
{
   main();
}
catch ( e )
{
   console.criticalln( e.message || e );
}
