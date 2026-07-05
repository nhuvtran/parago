import { describe, it, expect } from 'vitest';
import { parseProductMeta, extractProductDetail, productPageAsin } from '../src/lib/parseProduct.js';

// The DOM extractor runs in a product-page content script (full rendered DOM) — the
// reliable path for the guardian's Details. Verify against Amazon's stable /dp/ IDs.
describe('extractProductDetail (DOM)', () => {
  it('pulls rating, count, bullets, brand, date-first-available and rank', () => {
    document.body.innerHTML = `
      <a id="bylineInfo">Brand: MAREE</a>
      <span id="acrPopover" title="4.6 out of 5 stars"></span>
      <span id="acrCustomerReviewText">1,204 ratings</span>
      <div id="feature-bullets"><ul>
        <li><span class="a-list-item">100% natural batana oil</span></li>
        <li><span class="a-list-item">Cold-pressed in Honduras</span></li>
        <li><span class="a-list-item">Make sure this fits by entering your model number.</span></li>
      </ul></div>
      <div id="detailBullets_feature_div"><ul>
        <li><span class="a-text-bold">Date First Available</span> <span>June 1, 2024</span></li>
        <li><span class="a-text-bold">Best Sellers Rank</span> <span>#1,234 in Beauty (See Top 100)</span></li>
      </ul></div>`;
    const d = extractProductDetail(document);
    expect(d.rating).toBe(4.6);
    expect(d.reviewCount).toBe(1204);
    expect(d.bullets).toEqual(['100% natural batana oil', 'Cold-pressed in Honduras']); // filler dropped
    expect(d.brand).toBe('Brand: MAREE');
    expect(d.dateFirstAvailable).toBe('June 1, 2024');
    expect(d.rank).toBe('#1,234 in Beauty');
  });

  it('productPageAsin reads the ASIN from a hidden input', () => {
    document.body.innerHTML = '<input id="ASIN" value="B0FRSGJVM6">';
    expect(productPageAsin(document)).toBe('B0FRSGJVM6');
  });
});

// parseProductMeta runs in the MV3 service worker (no DOMParser), so it parses an
// HTML STRING with regex. These cover a normal product page, a CAPTCHA/robot wall,
// non-string input, and a page with a rating but no review-count element.
describe('parseProductMeta', () => {
  it('pulls rating and review count from a product page', () => {
    const html = `
      <div>
        <span class="a-icon-alt">4.7 out of 5 stars</span>
        <span id="acrCustomerReviewText">18,432 ratings</span>
      </div>`;
    expect(parseProductMeta(html)).toMatchObject({ rating: 4.7, reviewCount: 18432 });
  });

  it('returns nulls for a robot/CAPTCHA page with neither', () => {
    const html = `
      <h4>Enter the characters you see below</h4>
      <p>Sorry, we just need to make sure you're not a robot.</p>`;
    expect(parseProductMeta(html)).toMatchObject({ rating: null, reviewCount: null });
  });

  it('returns nulls for non-string input', () => {
    expect(parseProductMeta(null)).toMatchObject({ rating: null, reviewCount: null });
    expect(parseProductMeta(undefined)).toMatchObject({ rating: null, reviewCount: null });
    expect(parseProductMeta(42)).toMatchObject({ rating: null, reviewCount: null });
    expect(parseProductMeta({})).toMatchObject({ rating: null, reviewCount: null });
    expect(parseProductMeta('')).toMatchObject({ rating: null, reviewCount: null });
  });

  it('sets rating but leaves reviewCount null when no review element', () => {
    const html = '<span class="a-icon-alt">3.5 out of 5 stars</span>';
    const meta = parseProductMeta(html);
    expect(meta.rating).toBe(3.5);
    expect(meta.reviewCount).toBeNull();
  });

  it('handles the live parenthesised count markup, e.g. >(1,039,135)<', () => {
    // Verified against a real /dp/ page (2026-06): Amazon renders the acr element
    // as "(1,039,135)", so the preferred path must tolerate a non-digit prefix.
    const html = '<span class="a-icon-alt">4.7 out of 5 stars</span>' +
      '<a><span id="acrCustomerReviewText" class="a-size-base">(1,039,135)</span></a>';
    expect(parseProductMeta(html)).toMatchObject({ rating: 4.7, reviewCount: 1039135 });
  });

  it('falls back to a "N ratings" phrase when the element is absent', () => {
    const html = '<span>4.0 out of 5</span><span>1,205 global ratings</span>';
    expect(parseProductMeta(html)).toMatchObject({ rating: 4.0, reviewCount: 1205 });
  });
});

import { productDetailFields } from '../src/lib/parseProduct.js';

describe('parseProductMeta detail extraction', () => {
  it('pulls feature bullets, date first available, rank and brand', () => {
    const html = `
      <a id="bylineInfo">Brand: Anker</a>
      <div id="feature-bullets">
        <ul>
          <li><span class="a-list-item">Fast 100W charging</span></li>
          <li><span class="a-list-item">Durable braided nylon</span></li>
          <li><span class="a-list-item">Make sure this fits by entering your model number.</span></li>
        </ul>
      </div>
      <div id="detailBullets_feature_div">
        <ul>
          <li><span class="a-text-bold">Date First Available</span> <span>June 1, 2020</span></li>
          <li><span class="a-text-bold">Best Sellers Rank</span> <span>#1,234 in Electronics (See Top 100)</span></li>
        </ul>
      </div>`;
    const meta = parseProductMeta(html);
    expect(meta.bullets).toEqual(['Fast 100W charging', 'Durable braided nylon']); // filler line dropped
    expect(meta.dateFirstAvailable).toBe('June 1, 2020');
    expect(meta.rank).toBe('#1,234 in Electronics');
    expect(meta.brand).toBe('Brand: Anker');
  });

  it('reads Date First Available from a product-details table', () => {
    const html = `
      <table id="productDetails_detailBullets_sections1">
        <tr><th>Date First Available</th><td>March 3, 2019</td></tr>
      </table>`;
    expect(parseProductMeta(html).dateFirstAvailable).toBe('March 3, 2019');
  });

  it('productDetailFields returns only the populated extras, or null', () => {
    expect(productDetailFields({ bullets: [], dateFirstAvailable: null, rank: null, brand: null })).toBeNull();
    expect(productDetailFields({ bullets: ['a'], rank: '#5 in Books' }))
      .toEqual({ bullets: ['a'], rank: '#5 in Books' });
  });

  it('productDetailFields carries the gallery + videos (capped)', () => {
    const out = productDetailFields({
      gallery: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'],
      videos: [{ url: 'v1' }, { url: 'v2' }, { url: 'v3' }],
    });
    expect(out.gallery).toHaveLength(6); // capped
    expect(out.videos).toHaveLength(2);  // capped
  });
});

// Verified against a real /dp/ DOM (B09FXVQ8WN, 2026-07): #altImages thumbnails carry
// ._AC_US40_ srcs to upsize, and product videos live in page state as
// ".../<id>.mp4/productVideoOptimized.mp4" with a paired ".../THUMBNAIL_...JPG" poster.
describe('gallery + video extraction', () => {
  it('extractProductDetail: upsized, deduped gallery from #altImages (video thumbs excluded) + videos', () => {
    document.body.innerHTML = `
      <div id="altImages"><ul>
        <li class="item itemNo0 imageThumbnail variant-MAIN"><img src="https://m.media-amazon.com/images/I/51dd84jReKL._AC_US40_.jpg"></li>
        <li class="item itemNo1 imageThumbnail variant-PT01"><img src="https://m.media-amazon.com/images/I/41lLJtmTH8L._AC_US40_.jpg"></li>
        <li class="item itemNo2 imageThumbnail variant-PT02"><img src="https://m.media-amazon.com/images/I/41lLJtmTH8L._AC_US40_.jpg"></li>
        <li class="item videoThumbnail"><img src="https://m.media-amazon.com/images/I/shouldbeignored._AC_US40_.jpg"></li>
      </ul></div>
      <script type="a-state">{"videos":[{"url":"https://m.media-amazon.com/images/S/al-na-9d/dbc5154f.mp4/productVideoOptimized.mp4","slate":"https://m.media-amazon.com/images/S/al-na-9d/dbc5154f.mp4/r/THUMBNAIL_360P_FRAME_3_CAPTURE_2.JPG"}]}</script>`;
    const d = extractProductDetail(document);
    expect(d.gallery).toEqual([
      'https://m.media-amazon.com/images/I/51dd84jReKL._AC_SL1200_.jpg',
      'https://m.media-amazon.com/images/I/41lLJtmTH8L._AC_SL1200_.jpg',
    ]);
    expect(d.videos).toEqual([{
      url: 'https://m.media-amazon.com/images/S/al-na-9d/dbc5154f.mp4/productVideoOptimized.mp4',
      poster: 'https://m.media-amazon.com/images/S/al-na-9d/dbc5154f.mp4/r/THUMBNAIL_360P_FRAME_3_CAPTURE_2.JPG',
    }]);
  });

  it('extractProductDetail: falls back to the hi-res main image when there is no thumbnail strip', () => {
    document.body.innerHTML = `<div id="imgTagWrapperId"><img id="landingImage" src="https://m.media-amazon.com/images/I/81rRSIKm2TL._AC_SX466_.jpg" data-old-hires="https://m.media-amazon.com/images/I/81rRSIKm2TL._AC_SL1500_.jpg"></div>`;
    expect(extractProductDetail(document).gallery).toEqual(['https://m.media-amazon.com/images/I/81rRSIKm2TL._AC_SL1500_.jpg']);
  });

  it('parseProductMeta: gallery from hiRes state + videos from the HTML string', () => {
    const html = `
      <script>var d={"colorImages":{"initial":[{"hiRes":"https://m.media-amazon.com/images/I/81rRSIKm2TL._AC_SL1500_.jpg","large":"https://m.media-amazon.com/images/I/51dd84jReKL._AC_.jpg"},{"hiRes":"https://m.media-amazon.com/images/I/71d6-vOQVTL._AC_SL1500_.jpg"}]}};</script>
      <script>{"url":"https://m.media-amazon.com/images/S/al-na/aaa.mp4/productVideoOptimized.mp4","poster":"https://m.media-amazon.com/images/S/al-na/aaa.mp4/r/THUMBNAIL_1.JPG"}</script>`;
    const m = parseProductMeta(html);
    expect(m.gallery).toEqual([
      'https://m.media-amazon.com/images/I/81rRSIKm2TL._AC_SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71d6-vOQVTL._AC_SL1500_.jpg',
    ]);
    expect(m.videos).toEqual([{
      url: 'https://m.media-amazon.com/images/S/al-na/aaa.mp4/productVideoOptimized.mp4',
      poster: 'https://m.media-amazon.com/images/S/al-na/aaa.mp4/r/THUMBNAIL_1.JPG',
    }]);
  });
});
