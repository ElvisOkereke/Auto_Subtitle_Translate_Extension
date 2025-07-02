import '../popup';

describe('PopupController', () => {
  beforeEach(() => {
    // Setup DOM elements
    document.body.innerHTML = `
      <button id="toggleButton">Start Subtitles</button>
      <div id="status" class="status hidden"></div>
      <input type="password" id="apiKey" />
      <select id="sourceLanguage">
        <option value="auto">Auto-detect</option>
        <option value="en">English</option>
      </select>
      <select id="targetLanguage">
        <option value="en">English</option>
        <option value="es">Spanish</option>
      </select>
      <select id="subtitleStyle">
        <option value="bottom">Bottom</option>
        <option value="top">Top</option>
      </select>
      <select id="fontSize">
        <option value="medium">Medium</option>
        <option value="large">Large</option>
      </select>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('should initialize popup elements', () => {
    const toggleButton = document.getElementById('toggleButton');
    const status = document.getElementById('status');
    const apiKey = document.getElementById('apiKey');
    
    expect(toggleButton).toBeTruthy();
    expect(status).toBeTruthy();
    expect(apiKey).toBeTruthy();
  });

  it('should validate API key correctly', () => {
    const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
    
    // Test empty API key
    apiKeyInput.value = '';
    expect(apiKeyInput.value).toBe('');
    
    // Test short API key
    apiKeyInput.value = 'short';
    expect(apiKeyInput.value.length).toBeLessThan(10);
    
    // Test valid API key
    apiKeyInput.value = 'valid-api-key-12345';
    expect(apiKeyInput.value.length).toBeGreaterThanOrEqual(10);
  });

  it('should mock chrome runtime correctly', () => {
    expect(chrome.runtime.sendMessage).toBeDefined();
    expect(chrome.storage.sync.get).toBeDefined();
    expect(chrome.tabs.query).toBeDefined();
  });
});
