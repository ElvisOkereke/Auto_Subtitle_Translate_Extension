describe('jest environment', () => {
  it('runs in a jsdom environment with window and document available', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });
});
