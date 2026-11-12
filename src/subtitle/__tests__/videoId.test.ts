import { videoIdFrom } from '../videoId';

describe('videoIdFrom', () => {
  it('reads watch URLs', () => {
    expect(videoIdFrom('https://www.youtube.com/watch?v=_zIrbXw-SVs&t=540')).toBe('_zIrbXw-SVs');
  });
  it('reads youtu.be short links', () => {
    expect(videoIdFrom('https://youtu.be/_zIrbXw-SVs?si=abc')).toBe('_zIrbXw-SVs');
  });
  it('reads shorts URLs', () => {
    expect(videoIdFrom('https://www.youtube.com/shorts/abcDEF12345')).toBe('abcDEF12345');
  });
  it('scopes ids from other sites to that site (no reuse of saved YouTube boxes or lines)', () => {
    expect(videoIdFrom('http://127.0.0.1:5000/video-subs.html?v=otherVideo01&stretch=s2')).toBe('http://127.0.0.1:5000/video-subs.html?v=otherVideo01');
    expect(videoIdFrom('https://evil.example/watch?v=_zIrbXw-SVs')).toBe('https://evil.example/watch?v=_zIrbXw-SVs');
    expect(videoIdFrom('https://youtube.com.evil.example/watch?v=_zIrbXw-SVs')).not.toBe('_zIrbXw-SVs');
    expect(videoIdFrom('https://evil.example/shorts/abcDEF12345')).not.toBe('abcDEF12345');
  });
  it('accepts YouTube hosts and subdomains', () => {
    expect(videoIdFrom('https://m.youtube.com/watch?v=_zIrbXw-SVs')).toBe('_zIrbXw-SVs');
    expect(videoIdFrom('https://youtube.com/watch?v=_zIrbXw-SVs')).toBe('_zIrbXw-SVs');
  });
  it('returns null for pages without a video id', () => {
    expect(videoIdFrom('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(videoIdFrom('not a url')).toBeNull();
  });
});
