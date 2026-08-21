import { BoundedTtlMap } from '../../src/modules/voice/util/bounded-ttl-map';

describe('BoundedTtlMap.delete', () => {
  it('removes only the named key', () => {
    const map = new BoundedTtlMap<string>(10, 60_000, () => 1_000);
    map.set('a', 'alpha');
    map.set('b', 'beta');

    map.delete('a');

    // Literal pins: 1 and undefined are written out, never derived from the map.
    expect(map.size).toBe(1);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('b')).toBe('beta');
  });

  it('is a no-op for a key that is not present', () => {
    const map = new BoundedTtlMap<string>(10, 60_000, () => 1_000);
    map.set('a', 'alpha');

    expect(() => map.delete('missing')).not.toThrow();
    expect(map.size).toBe(1);
    expect(map.get('a')).toBe('alpha');
  });

  it('frees the slot it occupied, so no other live entry is evicted for it', () => {
    // Delete the NEWEST entry, then add one. If delete were a no-op, `set`
    // would hit the cap and evict the oldest — 'a' — to make room. A working
    // delete means the slot is already free and 'a' survives.
    //
    // Deleting the oldest entry instead would prove nothing here: the eviction
    // loop would remove that same key anyway, and the test would pass against
    // a delete that does nothing at all.
    const map = new BoundedTtlMap<string>(2, 60_000, () => 1_000);
    map.set('a', 'alpha');
    map.set('b', 'beta');

    map.delete('b');
    map.set('c', 'gamma');

    expect(map.size).toBe(2);
    expect(map.get('a')).toBe('alpha');
    expect(map.get('c')).toBe('gamma');
    expect(map.get('b')).toBeUndefined();
  });
});
