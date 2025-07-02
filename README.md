# Auto Subtitle Translator Extension

A Chrome browser extension that automatically generates subtitles from audio and translates them to your preferred language in real-time.

## Features

- 🎧 **Real-time Audio Capture**: Captures audio from any browser tab
- 🗣️ **Speech Recognition**: Converts speech to text using cloud APIs
- 🌍 **Translation**: Translates subtitles to your preferred language
- 🎨 **Customizable Display**: Adjustable position, size, and styling
- 📱 **Cross-Platform**: Works on any website with audio/video content
- 🔒 **Privacy Options**: Configurable API usage and data handling

## Installation

### Development Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd auto-subtitle-translator
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the extension**
   ```bash
   npm run build:dev
   ```

4. **Load in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `dist` folder

### Production Build

```bash
npm run build:prod
npm run package
```

## Configuration

### API Setup

You'll need to configure API keys for speech recognition and translation services:

1. **Google Cloud Speech-to-Text API**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Enable Speech-to-Text API
   - Create credentials and get your API key

2. **Translation Service**
   - Choose from Google Translate API, Azure Translator, or DeepL API
   - Get your API key from the respective service

3. **Configure in Extension**
   - Click the extension icon
   - Enter your API key in the popup
   - Select source and target languages

## Usage

1. **Start Subtitles**
   - Navigate to any page with audio/video content
   - Click the extension icon
   - Click "Start Subtitles"

2. **Customize Display**
   - Choose subtitle position (top, center, bottom)
   - Adjust font size
   - Select target language for translation

3. **Stop Subtitles**
   - Click "Stop Subtitles" in the popup
   - Or navigate away from the page

## Architecture

### Core Components

- **Background Script (`background.js`)**
  - Manages audio capture using Chrome's tabCapture API
  - Handles API calls for speech recognition and translation
  - Coordinates between content scripts and popup

- **Content Script (`content.js`)**
  - Injects subtitle overlay into web pages
  - Manages video element detection and event handling
  - Displays subtitles with customizable styling

- **Popup (`popup.html/js`)**
  - User interface for controlling the extension
  - Settings management and API key configuration
  - Real-time status updates

### Data Flow

1. **Audio Capture**: Background script captures tab audio
2. **Speech Recognition**: Audio chunks sent to speech API
3. **Translation**: Text translated if needed
4. **Display**: Subtitles shown via content script overlay

## API Integration

### Speech Recognition

Currently configured for Google Cloud Speech-to-Text, but easily adaptable:

```javascript
// Example API call structure
const response = await fetch('https://your-backend-api.com/speech-to-text', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    audio: audioData,
    language: sourceLanguage
  })
});
```

### Translation

Supports multiple translation providers:

```javascript
// Translation API call
const response = await fetch('https://your-backend-api.com/translate', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    text: transcript,
    targetLanguage: targetLang
  })
});
```

## Customization

### Adding New Languages

Edit the language options in `popup.html`:

```html
<option value="your-lang-code">Your Language</option>
```

### Styling Subtitles

Modify `subtitle-overlay.css` to customize appearance:

```css
.subtitle-text {
  background: rgba(0, 0, 0, 0.85);
  color: white;
  font-size: 18px;
  /* Add your custom styles */
}
```

### Site-Specific Compatibility

Add site-specific CSS rules for better integration:

```css
/* Example for YouTube */
.ytd-player .subtitle-overlay {
  bottom: 15% !important;
}
```

## Development

### File Structure

```
auto-subtitle-translator/
├── manifest.json           # Extension manifest
├── background.js          # Service worker
├── content.js            # Content script
├── popup.html           # Popup interface
├── popup.js            # Popup logic
├── subtitle-overlay.css # Subtitle styling
├── package.json        # Node.js dependencies
├── webpack.config.js   # Build configuration
└── icons/             # Extension icons
```

### Scripts

- `npm run build:dev` - Development build with source maps
- `npm run build:prod` - Production build (minified)
- `npm run watch` - Development build with file watching
- `npm run lint` - Code linting
- `npm run test` - Run tests
- `npm run package` - Create extension package

### Testing

```bash
# Run unit tests
npm test

# Manual testing
npm run build:dev
# Load extension in Chrome and test on various sites
```

## Troubleshooting

### Common Issues

1. **No Audio Capture**
   - Check if site allows audio access
   - Verify tabCapture permissions
   - Try refreshing the page

2. **API Errors**
   - Verify API key is correct
   - Check API quotas and billing
   - Monitor network requests in DevTools

3. **Subtitles Not Showing**
   - Check if content script loaded properly
   - Verify CSS z-index conflicts
   - Test on different websites

### Debug Mode

Enable debug logging by setting:

```javascript
// In background.js
const DEBUG = true;
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Chrome Extensions API documentation
- Web Speech API contributors
- Translation service providers
- Open source community

## Roadmap

- [ ] Local speech recognition models
- [ ] Improved accuracy for noisy audio
- [ ] Subtitle history and export
- [ ] Multiple speaker detection
- [ ] Mobile browser support
- [ ] Offline translation capabilities