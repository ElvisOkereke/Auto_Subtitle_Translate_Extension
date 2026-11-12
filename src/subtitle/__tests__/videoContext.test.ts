import { readVideoContext } from '../videoContext';

const docFrom = (html: string, title = '') => {
  const doc = document.implementation.createHTMLDocument(title);
  doc.documentElement.innerHTML = html;
  if (title) doc.title = title;
  return doc;
};

describe('readVideoContext', () => {
  it('reads YouTube title, channel and description', () => {
    const doc = docFrom(
      `<head><title>뽀삐 장인의 솔랭 - YouTube</title><meta name="description" content="League of Legends solo queue"></head>
       <body><ytd-watch-metadata><h1><yt-formatted-string>뽀삐 장인의 솔랭</yt-formatted-string></h1></ytd-watch-metadata>
       <div id="owner"><ytd-channel-name id="channel-name"><a href="/@x">롤 스트리머</a></ytd-channel-name></div></body>`
    );
    expect(readVideoContext(doc, 'https://www.youtube.com/watch?v=_zIrbXw-SVs')).toEqual({
      videoId: '_zIrbXw-SVs',
      url: 'https://www.youtube.com/watch?v=_zIrbXw-SVs',
      title: '뽀삐 장인의 솔랭',
      channel: '롤 스트리머',
      description: 'League of Legends solo queue',
    });
  });

  it('falls back to document title and meta description elsewhere', () => {
    const doc = docFrom(
      `<head><title>El Clásico highlights</title><meta property="og:site_name" content="SportsTube"><meta property="og:description" content="Real Madrid vs Barcelona"></head><body></body>`
    );
    expect(readVideoContext(doc, 'https://sports.example/v/123')).toEqual({
      videoId: null,
      url: 'https://sports.example/v/123',
      title: 'El Clásico highlights',
      channel: 'SportsTube',
      description: 'Real Madrid vs Barcelona',
    });
  });

  it('caps description at 1000 chars and title at 300', () => {
    const doc = docFrom(`<head><title>${'t'.repeat(400)}</title><meta name="description" content="${'d'.repeat(2000)}"></head><body></body>`);
    const ctx = readVideoContext(doc, 'https://x.example/');
    expect(ctx.description).toHaveLength(1000);
    expect(ctx.title).toHaveLength(300);
  });
});
