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
  it('reads the fixture page ?v= parameter', () => {
    expect(videoIdFrom('http://127.0.0.1:5000/video-subs.html?v=otherVideo01&stretch=s2')).toBe('otherVideo01');
  });
  it('returns null for pages without a video id', () => {
    expect(videoIdFrom('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(videoIdFrom('not a url')).toBeNull();
  });
});
