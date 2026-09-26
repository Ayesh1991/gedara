import { describe, expect, it } from 'vitest';
import { parseOffQuantity, toOffInfo } from './off';

describe('Open Food Facts', () => {
  it('reads pack sizes into g / ml / pcs', () => {
    expect(parseOffQuantity('400 g')).toEqual({ qty: 400, unit: 'g' });
    expect(parseOffQuantity('1 kg')).toEqual({ qty: 1000, unit: 'g' });
    expect(parseOffQuantity('1,5 L')).toEqual({ qty: 1500, unit: 'ml' });
    expect(parseOffQuantity('6 x 200 ml')).toEqual({ qty: 1200, unit: 'ml' });
    expect(parseOffQuantity('33cl')).toEqual({ qty: 330, unit: 'ml' });
    expect(parseOffQuantity('12 pcs')).toEqual({ qty: 12, unit: 'pcs' });
    expect(parseOffQuantity('a family pack')).toBeNull();
  });

  it('maps a found product, putting the brand first once', () => {
    expect(
      toOffInfo({
        status: 1,
        product: {
          product_name: 'Milk Powder',
          brands: 'Anchor, Fonterra',
          quantity: '400 g',
          image_front_small_url: 'https://images.openfoodfacts.org/images/products/1.jpg',
          categories_tags: ['en:dairies'],
        },
      }),
    ).toEqual({
      name: 'Anchor Milk Powder',
      brand: 'Anchor',
      pack: { qty: 400, unit: 'g' },
      imageUrl: 'https://images.openfoodfacts.org/images/products/1.jpg',
      categories: ['en:dairies'],
    });
    expect(toOffInfo({ status: 1, product: { product_name: 'Maliban Cream Crackers', brands: 'Maliban' } })?.name).toBe('Maliban Cream Crackers');
  });

  it('ignores unknown products, bad shapes and foreign image hosts', () => {
    expect(toOffInfo({ status: 0 })).toBeNull();
    expect(toOffInfo({ status: 1, product: { product_name: 5 } })).toBeNull();
    expect(toOffInfo('<html>')).toBeNull();
    expect(toOffInfo({ status: 1, product: { product_name: 'X', image_front_small_url: 'https://evil.example/x.jpg' } })?.imageUrl).toBeNull();
  });
});
