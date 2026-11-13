// popup.ts - Popup interface logic

import { ExtensionSettings } from './types';
import { DEFAULT_SETTINGS, getSecrets } from './settings';
import { validateGatewayUrl } from './translation/claudeAccess';
import { applyTheme, ThemeChoice } from './theme';
import { captionText, engineSummaryText, PopupState } from './popupText';

interface PopupElements {
  toggleButton: HTMLButtonElement;
  screenTranslateButton: HTMLButtonElement;
  drawNewBoxButton: HTMLButtonElement;
  screenTranslateStatus: HTMLDivElement;
  status: HTMLDivElement;
  sourceLanguage: HTMLSelectElement;
  targetLanguage: HTMLSelectElement;
  subtitleStyle: HTMLSelectElement;
  fontSize: HTMLSelectElement;
  translationProvider: HTMLSelectElement;
  googleTranslateApiKey: HTMLInputElement;
  deeplApiKey: HTMLInputElement;
  googleApiKeyGroup: HTMLDivElement;
  deeplApiKeyGroup: HTMLDivElement;
  modeAudio: HTMLButtonElement;
  modeSubtitles: HTMLButtonElement;
  audioPanel: HTMLDivElement;
  subtitlePanel: HTMLDivElement;
  subtitleLanguage: HTMLSelectElement;
  startSubtitleMode: HTMLButtonElement;
  drawSubtitleBox: HTMLButtonElement;
  stopSubtitleMode: HTMLButtonElement;
  subtitleModeStatus: HTMLDivElement;
  engineMode: HTMLSelectElement;
  claudeModel: HTMLSelectElement;
  claudeAccess: HTMLSelectElement;
  anthropicApiKey: HTMLInputElement;
  claudeGatewayUrl: HTMLInputElement;
  claudeGatewayToken: HTMLInputElement;
  claudeGatewayAuth: HTMLSelectElement;
  anthropicKeyGroup: HTMLDivElement;
  claudeGatewayGroup: HTMLDivElement;
  claudeStatus: HTMLDivElement;
  glossaryTopic: HTMLDivElement;
  glossaryList: HTMLDivElement;
  accountEmail: HTMLInputElement;
  accountSendCode: HTMLButtonElement;
  accountCodeRow: HTMLDivElement;
  accountCode: HTMLInputElement;
  accountSignIn: HTMLButtonElement;
  signedOutView: HTMLDivElement;
  signedInView: HTMLDivElement;
  accountEmailShown: HTMLDivElement;
  accountPlan: HTMLDivElement;
  accountUsage: HTMLDivElement;
  accountUsageBar: HTMLProgressElement;
  accountSubscribeStandard: HTMLButtonElement;
  accountSubscribePro: HTMLButtonElement;
  accountManage: HTMLButtonElement;
  accountSignOut: HTMLButtonElement;
  accountStatus: HTMLDivElement;
  openSettings: HTMLElement;
  closeSettings: HTMLElement;
  mainView: HTMLElement;
  settingsView: HTMLElement;
  captionBar: HTMLParagraphElement;
  translateWithGroup: HTMLElement;
  translateWithSubscription: HTMLElement;
  translateWithKeys: HTMLElement;
  ownKeysGroup: HTMLElement;
  themeChoice: HTMLSelectElement;
  engineSummary: HTMLElement;
  accountSummary: HTMLElement;
  engineSummaryValue: HTMLElement;
  accountSummaryValue: HTMLElement;
}

const ELEMENT_IDS: (keyof PopupElements)[] = [
  'toggleButton', 'screenTranslateButton', 'drawNewBoxButton', 'screenTranslateStatus', 'status',
  'sourceLanguage', 'targetLanguage', 'subtitleStyle', 'fontSize', 'translationProvider',
  'googleTranslateApiKey', 'deeplApiKey', 'googleApiKeyGroup', 'deeplApiKeyGroup',
  'modeAudio', 'modeSubtitles', 'audioPanel', 'subtitlePanel', 'subtitleLanguage',
  'startSubtitleMode', 'drawSubtitleBox', 'stopSubtitleMode', 'subtitleModeStatus',
  'engineMode', 'claudeModel', 'claudeAccess', 'anthropicApiKey', 'claudeGatewayUrl', 'claudeGatewayToken',
  'claudeGatewayAuth', 'anthropicKeyGroup', 'claudeGatewayGroup', 'claudeStatus', 'glossaryTopic', 'glossaryList',
  'accountEmail', 'accountSendCode', 'accountCodeRow', 'accountCode', 'accountSignIn', 'signedOutView', 'signedInView', 'accountEmailShown', 'accountPlan', 'accountUsage', 'accountUsageBar', 'accountSubscribeStandard', 'accountSubscribePro', 'accountManage', 'accountSignOut', 'accountStatus',
  'openSettings', 'closeSettings', 'mainView', 'settingsView', 'captionBar', 'translateWithGroup', 'translateWithSubscription', 'translateWithKeys', 'ownKeysGroup', 'themeChoice', 'engineSummary', 'accountSummary', 'engineSummaryValue', 'accountSummaryValue'
];

const MODE_LABELS: Record<string, string> = {
  'fast-then-best': 'Fast then best (DeepL, then Claude)',
  fast: 'Fast only',
  best: 'Best only (Claude)',
};

/**
 * The tab the popup controls. Normally the active tab of the popup's window;
 * `popup.html?tabId=N` pins it to a specific tab (used by the E2E harness,
 * which opens the popup as a regular page rather than via the toolbar).
 */
export async function getTargetTab(): Promise<chrome.tabs.Tab | undefined> {
  const pinned = Number(new URLSearchParams(location.search).get('tabId'));
  if (Number.isInteger(pinned) && pinned > 0) {
    return chrome.tabs.get(pinned);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Turns "no content script in this tab" into something a user can act on. */
export function describeTabError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return "this page can't run the extension (browser pages, the Web Store, or tabs opened before install - try reloading the page).";
  }
  return message;
}

const NON_SETTING_ELEMENT_KEYS = [
  'toggleButton',
  'screenTranslateButton',
  'drawNewBoxButton',
  'screenTranslateStatus',
  'status',
  'googleApiKeyGroup',
  'deeplApiKeyGroup',
  'modeAudio',
  'modeSubtitles',
  'audioPanel',
  'subtitlePanel',
  'startSubtitleMode',
  'drawSubtitleBox',
  'stopSubtitleMode',
  'subtitleModeStatus',
  'anthropicKeyGroup',
  'claudeGatewayGroup',
  'claudeStatus',
  'glossaryTopic',
  'glossaryList',
  'accountEmail',
  'accountSendCode',
  'accountCodeRow',
  'accountCode',
  'accountSignIn',
  'signedOutView',
  'signedInView',
  'accountEmailShown',
  'accountPlan',
  'accountUsage',
  'accountUsageBar',
  'accountSubscribeStandard',
  'accountSubscribePro',
  'accountManage',
  'accountSignOut',
  'accountStatus',
  'openSettings',
  'closeSettings',
  'mainView',
  'settingsView',
  'captionBar',
  'translateWithGroup',
  'translateWithSubscription',
  'translateWithKeys',
  'ownKeysGroup',
  'engineSummary',
  'accountSummary',
  'engineSummaryValue',
  'accountSummaryValue'
];

interface AccountView {
  email: string;
  plan: 'free' | 'standard' | 'pro';
  active: boolean;
  usageUsd: number;
  budgetUsd: number;
  warn: boolean;
  exhausted: boolean;
}

const PLAN_LABELS: Record<string, string> = { free: 'Free', standard: 'Standard', pro: 'Pro' };

class PopupController {
  private isActive: boolean;
  private isScreenTranslating: boolean;
  private elements: PopupElements;
  /** Bumped by every user action so a slow initial state query can't overwrite it. */
  private screenTranslateActionCount = 0;
  private signedIn = false;
  private hostedAvailable = false;
  private accountActive = false;
  private subtitleState: PopupState['subtitleState'] = 'off';
  private hasBox = false;
  private screenState: PopupState['screenTranslate'] = 'inactive';
  private currentMode: 'audio' | 'subtitles' = 'audio';
  private stopTheme: () => void = () => undefined;

  private optionText(select: HTMLSelectElement): string {
    return select.selectedOptions[0]?.textContent?.trim() ?? select.value;
  }

  /** The caption bar: the current state as one subtitle-like line. */
  private renderCaption() {
    const e = this.elements;
    e.captionBar.textContent = captionText({
      mode: this.currentMode,
      audioRunning: this.isActive,
      subtitleState: this.subtitleState,
      hasBox: this.hasBox,
      subtitleLanguage: this.optionText(e.subtitleLanguage),
      speechLanguage: this.optionText(e.sourceLanguage),
      targetLanguage: this.optionText(e.targetLanguage),
      screenTranslate: this.screenState,
    });
  }

  /** The Engine row on the main view. */
  private renderEngineSummary() {
    const e = this.elements;
    const gateway = e.claudeAccess.value === 'gateway';
    const subscription = e.claudeAccess.value === 'subscription' || e.translationProvider.value === 'subscription';
    const provider = e.translationProvider.value as 'deepl' | 'google' | 'subscription';
    const hasFastKey = provider === 'deepl' ? !!e.deeplApiKey.value : provider === 'google' ? !!e.googleTranslateApiKey.value : this.signedIn;
    const hasClaude = subscription ? this.signedIn : gateway ? !!e.claudeGatewayUrl.value && !!e.claudeGatewayToken.value : !!e.anthropicApiKey.value;
    e.engineSummaryValue.textContent = engineSummaryText({
      translateWith: subscription ? 'subscription' : 'keys',
      provider,
      hasFastKey,
      hasClaude,
      engineMode: e.engineMode.value as 'fast-then-best' | 'fast' | 'best',
      modelLabel: this.optionText(e.claudeModel).replace(/\s*\(.*\)$/, ''),
      account: !this.signedIn ? 'signed-out' : this.accountActive ? 'active' : 'not-subscribed',
    });
  }

  // ---- views ----

  private showView(view: 'main' | 'settings', sectionId?: string) {
    const e = this.elements;
    const settings = view === 'settings';
    e.mainView.classList.toggle('hidden', settings);
    e.settingsView.classList.toggle('hidden', !settings);
    const shown = settings ? e.settingsView : e.mainView;
    shown.classList.remove('entering', 'entering-back');
    void shown.offsetWidth; // restart the slide animation
    shown.classList.add(settings ? 'entering' : 'entering-back');
    if (settings && sectionId) document.getElementById(sectionId)?.scrollIntoView({ block: 'start' });
    (settings ? e.closeSettings : e.openSettings).focus();
  }

  // ---- translate with: subscription or own keys ----

  private renderTranslateWith() {
    const e = this.elements;
    const subscription = e.translationProvider.value === 'subscription' || e.claudeAccess.value === 'subscription';
    e.translateWithGroup.classList.toggle('hidden', !this.hostedAvailable);
    e.translateWithSubscription.setAttribute('aria-checked', String(subscription));
    e.translateWithKeys.setAttribute('aria-checked', String(!subscription));
    e.ownKeysGroup.classList.toggle('hidden', subscription && this.hostedAvailable);
  }

  private setTranslateWith(choice: 'subscription' | 'keys') {
    const e = this.elements;
    if (choice === 'subscription') {
      e.translationProvider.value = 'subscription';
      e.claudeAccess.value = 'subscription';
    } else {
      if (e.translationProvider.value === 'subscription') e.translationProvider.value = 'deepl';
      if (e.claudeAccess.value === 'subscription') e.claudeAccess.value = 'key';
    }
    this.updateApiKeyVisibility();
    this.updateClaudeFields();
    this.renderTranslateWith();
    this.renderEngineSummary();
    void this.saveSettings();
  }

  constructor() {
    this.isActive = false;
    this.isScreenTranslating = false;
    this.elements = {} as PopupElements;
    this.initializeElements();
    this.loadSettings();
    this.setupEventListeners();
    this.refreshScreenTranslateState();
    this.refreshSubtitleState();
    this.refreshSubtitleModeState();
    this.loadGlossary();
    this.refreshAccount();
  }

  // ---- account (hosted translation) ----

  private setAccountStatus(text: string, ok = false) {
    this.elements.accountStatus.textContent = text;
    this.elements.accountStatus.classList.toggle('ok', ok);
  }

  async refreshAccount(): Promise<void> {
    const r = await chrome.runtime.sendMessage({ type: 'ACCOUNT_STATUS' }).catch(() => null);
    this.setHostedAvailable(r?.available === true);
    this.renderAccount(r?.signedIn ? r.account : null);
    if (r && !r.success && r.error) this.setAccountStatus(r.error);
  }

  /** Hides the account section while no hosted service is configured. The Subscription options in the
   * engine dropdowns stay hidden either way: "Translate with" is the one place to choose the subscription. */
  private setHostedAvailable(available: boolean) {
    this.hostedAvailable = available;
    document.getElementById('accountSection')?.classList.toggle('hidden', !available);
    this.elements.accountSummary.classList.toggle('hidden', !available);
    this.renderTranslateWith();
    for (const select of [this.elements.claudeAccess, this.elements.translationProvider]) {
      for (const option of select.options) if (option.value === 'subscription') option.hidden = true;
    }
  }

  private renderAccount(account: AccountView | null) {
    const e = this.elements;
    this.signedIn = !!account;
    this.accountActive = !!account?.active;
    e.signedOutView.classList.toggle('hidden', !!account);
    e.signedInView.classList.toggle('hidden', !account);
    if (account) {
      e.accountEmailShown.textContent = account.email;
      e.accountPlan.textContent = `Plan: ${PLAN_LABELS[account.plan] ?? account.plan}${account.plan !== 'free' && !account.active ? ' (payment needed)' : ''}`;
      e.accountUsage.textContent = account.active ? `$${account.usageUsd.toFixed(2)} of $${account.budgetUsd.toFixed(2)} used this month` : '';
      e.accountUsageBar.classList.toggle('hidden', !account.active);
      e.accountUsageBar.value = account.budgetUsd ? Math.min(1, account.usageUsd / account.budgetUsd) : 0;
      e.accountSubscribeStandard.classList.toggle('hidden', account.active);
      // One subscription per account: upgrades/changes go through Manage subscription.
      e.accountSubscribePro.classList.toggle('hidden', account.active);
      e.accountManage.classList.toggle('hidden', !account.active);
      e.accountSummaryValue.textContent = account.active
        ? `${PLAN_LABELS[account.plan] ?? account.plan}, $${account.usageUsd.toFixed(2)} of $${account.budgetUsd.toFixed(2)} used`
        : `${account.email}, not subscribed`;
      if (!account.active) this.setAccountStatus('Subscribe to translate with the hosted service (no API keys needed).');
      else if (account.exhausted) this.setAccountStatus("This month's allowance is used up - upgrade, or use your own keys until next month.");
      else if (account.warn) this.setAccountStatus("You've used over 80% of this month's allowance.");
      else this.setAccountStatus('');
    }
    if (!account) e.accountSummaryValue.textContent = 'Sign in to use your subscription';
    this.updateClaudeFields();
    this.renderEngineSummary();
  }

  private async sendCode() {
    const email = this.elements.accountEmail.value.trim();
    if (!email) return this.setAccountStatus('Enter your email address.');
    this.setAccountStatus('Sending...');
    const r = await chrome.runtime.sendMessage({ type: 'ACCOUNT_START', email });
    if (!r?.success) return this.setAccountStatus(r?.error ?? 'Could not send the code.');
    this.elements.accountCodeRow.classList.remove('hidden');
    this.setAccountStatus(`Code sent to ${email}. It expires in 10 minutes.`, true);
    this.elements.accountCode.focus();
  }

  private async signIn() {
    const r = await chrome.runtime.sendMessage({ type: 'ACCOUNT_VERIFY', email: this.elements.accountEmail.value.trim(), code: this.elements.accountCode.value.trim() });
    if (!r?.success) return this.setAccountStatus(r?.error ?? 'Sign-in failed.');
    this.elements.accountCode.value = '';
    this.elements.accountCodeRow.classList.add('hidden');
    this.renderAccount(r.account);
  }

  private async openBilling(plan?: 'standard' | 'pro') {
    const r = await chrome.runtime.sendMessage({ type: 'BILLING_OPEN', ...(plan ? { plan } : {}) });
    if (!r?.success) this.setAccountStatus(r?.error ?? 'Could not open billing.');
  }

  private async signOut() {
    await chrome.runtime.sendMessage({ type: 'ACCOUNT_SIGNOUT' });
    this.renderAccount(null);
    this.setAccountStatus('Signed out.', true);
  }

  /** Glossary of the video in the target tab: learned names/terms, editable. */
  async loadGlossary(): Promise<void> {
    try {
      const tab = await getTargetTab();
      if (!tab?.id) return;
      const glossary = await chrome.runtime.sendMessage({ type: 'GET_GLOSSARY', tabId: tab.id });
      this.renderGlossary(tab.id, glossary);
    } catch (error) {
      console.warn('Glossary unavailable:', error);
    }
  }

  private renderGlossary(tabId: number, glossary: { topic: string | null; entries: { source: string; target: string; scope: string }[] } | undefined) {
    const list = this.elements.glossaryList;
    list.replaceChildren();
    this.elements.glossaryTopic.textContent = glossary?.topic ? `Topic: ${glossary.topic}` : '';
    const entries = glossary?.entries ?? [];
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'glossary-empty';
      empty.textContent = 'No names or terms learned for this video yet.';
      list.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'glossary-row';
      row.dataset.source = entry.source;
      const source = document.createElement('span');
      source.className = 'glossary-source';
      source.textContent = entry.source;
      const target = document.createElement('input');
      target.type = 'text';
      target.value = entry.target;
      target.maxLength = 80;
      target.setAttribute('aria-label', `Translation of ${entry.source}`);
      target.addEventListener('change', () => void this.editGlossary(tabId, entry.source, target.value));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = `Remove ${entry.source}`;
      remove.addEventListener('click', () => void this.editGlossary(tabId, entry.source, null));
      row.append(source, target, remove);
      list.append(row);
    }
  }

  private async editGlossary(tabId: number, source: string, target: string | null) {
    await chrome.runtime.sendMessage({ type: 'EDIT_GLOSSARY_ENTRY', tabId, source, target });
    await this.loadGlossary();
  }

  private subtitleModeRunning = false;

  /** Audio (live captions from speech) or Subtitles (burned-in subtitle translation). */
  setMode(mode: 'audio' | 'subtitles') {
    const subtitles = mode === 'subtitles';
    this.elements.modeAudio.classList.toggle('active', !subtitles);
    this.elements.modeSubtitles.classList.toggle('active', subtitles);
    this.elements.audioPanel.classList.toggle('hidden', subtitles);
    this.elements.subtitlePanel.classList.toggle('hidden', !subtitles);
    this.elements.modeAudio.setAttribute('aria-selected', String(!subtitles));
    this.elements.modeSubtitles.setAttribute('aria-selected', String(subtitles));
    this.currentMode = mode;
    this.renderCaption();
    chrome.storage.local?.set({ popupMode: mode }).catch(() => undefined);
  }

  async refreshSubtitleModeState() {
    let state: { mode?: string; state?: string; hasBox?: boolean } = {};
    try {
      const tab = await getTargetTab();
      if (tab?.id !== undefined) state = (await chrome.tabs.sendMessage(tab.id, { type: 'GET_SUBTITLE_MODE_STATE' })) ?? {};
    } catch {
      // page without content scripts
    }
    const stored = await chrome.storage.local?.get('popupMode').catch(() => ({}));
    this.subtitleModeRunning = state.mode === 'subtitles';
    const preferSubtitles = this.subtitleModeRunning || (!this.isActive && (stored as any)?.popupMode === 'subtitles');
    this.setMode(preferSubtitles ? 'subtitles' : 'audio');
    this.renderSubtitleMode(!!state.hasBox, state.state);
  }

  private renderSubtitleMode(hasBox: boolean, state?: string) {
    const running = this.subtitleModeRunning;
    this.elements.stopSubtitleMode.classList.toggle('hidden', !running);
    this.elements.startSubtitleMode.classList.toggle('hidden', running || !hasBox);
    this.elements.drawSubtitleBox.textContent = hasBox || running ? 'Redraw box' : 'Draw subtitle box';
    // The caption bar carries the state now.
    this.hasBox = hasBox;
    this.subtitleState = running ? (state === 'paused-ad' ? 'paused-ad' : state === 'loading' ? 'loading' : 'running') : 'off';
    this.elements.subtitleModeStatus.textContent = '';
    this.renderCaption();
  }

  private async sendToTab(message: Record<string, unknown>) {
    const tab = await getTargetTab();
    if (!tab || typeof tab.id !== 'number') throw new Error('No active tab found');
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async drawSubtitleBox() {
    try {
      if (this.isActive) await this.toggleSubtitles(); // one mode at a time
      await this.sendToTab({ type: 'DRAW_SUBTITLE_BOX', lang: this.elements.subtitleLanguage.value });
      this.showStatus('Drag a box around the subtitles on the video.', 'success');
    } catch (error) {
      this.showStatus('Failed to start: ' + describeTabError(error), 'error');
    }
  }

  async startSubtitleModeWithSavedBox() {
    try {
      if (this.isActive) await this.toggleSubtitles();
      const response = await this.sendToTab({ type: 'START_SUBTITLE_MODE' });
      if (!response?.success) throw new Error(response?.error || 'Could not start');
      await this.refreshSubtitleModeState();
    } catch (error) {
      this.showStatus('Failed to start: ' + describeTabError(error), 'error');
    }
  }

  async stopSubtitleMode() {
    try {
      await this.sendToTab({ type: 'STOP_SUBTITLE_MODE' });
    } catch {
      // nothing to stop
    }
    await this.refreshSubtitleModeState();
  }

  /** Subtitles are per tab, so ask the tab rather than trusting a stored flag. */
  async refreshSubtitleState() {
    try {
      const tab = await getTargetTab();
      if (!tab || typeof tab.id !== 'number') return;
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SUBTITLE_STATE' });
      this.isActive = response?.active === true;
    } catch {
      this.isActive = false;
    }
    this.updateToggleButton();
    // Live captions are running: open on the mode that can stop them.
    if (this.isActive && !this.subtitleModeRunning && this.currentMode !== 'audio') this.setMode('audio');
  }

  initializeElements() {
    const found: Partial<PopupElements> = {};
    for (const id of ELEMENT_IDS) {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Popup element #${id} not found in the DOM.`);
      (found as Record<string, HTMLElement>)[id] = el;
    }
    this.elements = found as PopupElements;
  }

  setupEventListeners() {
    this.elements.toggleButton.addEventListener('click', () => {
      this.toggleSubtitles();
    });

    this.elements.screenTranslateButton.addEventListener('click', () => {
      this.toggleScreenTranslation();
    });

    this.elements.drawNewBoxButton.addEventListener('click', () => {
      this.drawNewBox();
    });

    this.elements.modeAudio.addEventListener('click', () => this.setMode('audio'));
    this.elements.modeSubtitles.addEventListener('click', () => this.setMode('subtitles'));
    this.elements.drawSubtitleBox.addEventListener('click', () => this.drawSubtitleBox());
    this.elements.startSubtitleMode.addEventListener('click', () => this.startSubtitleModeWithSavedBox());
    this.elements.stopSubtitleMode.addEventListener('click', () => this.stopSubtitleMode());

    this.elements.translationProvider.addEventListener('change', () => {
      this.updateApiKeyVisibility();
    });
    this.elements.claudeAccess.addEventListener('change', () => this.updateClaudeFields());
    for (const select of [this.elements.claudeAccess, this.elements.translationProvider]) {
      select.addEventListener('change', () => this.renderTranslateWith());
    }
    this.elements.openSettings.addEventListener('click', () => this.showView('settings'));
    this.elements.closeSettings.addEventListener('click', () => this.showView('main'));
    for (const summary of [this.elements.engineSummary, this.elements.accountSummary]) {
      summary.addEventListener('click', () => this.showView('settings', summary.dataset.section));
    }
    this.elements.translateWithSubscription.addEventListener('click', () => this.setTranslateWith('subscription'));
    this.elements.translateWithKeys.addEventListener('click', () => this.setTranslateWith('keys'));
    this.elements.themeChoice.addEventListener('change', () => {
      this.stopTheme();
      this.stopTheme = applyTheme(document.documentElement, this.elements.themeChoice.value as ThemeChoice);
    });
    for (const select of [this.elements.subtitleLanguage, this.elements.sourceLanguage, this.elements.targetLanguage]) {
      select.addEventListener('change', () => this.renderCaption());
    }
    for (const field of [this.elements.translationProvider, this.elements.claudeAccess, this.elements.engineMode, this.elements.claudeModel, this.elements.deeplApiKey,
      this.elements.googleTranslateApiKey, this.elements.anthropicApiKey, this.elements.claudeGatewayUrl, this.elements.claudeGatewayToken]) {
      field.addEventListener('change', () => this.renderEngineSummary());
    }
    this.elements.accountSendCode.addEventListener('click', () => void this.sendCode());
    this.elements.accountSignIn.addEventListener('click', () => void this.signIn());
    this.elements.accountCode.addEventListener('keydown', e => e.key === 'Enter' && void this.signIn());
    this.elements.accountSubscribeStandard.addEventListener('click', () => void this.openBilling('standard'));
    this.elements.accountSubscribePro.addEventListener('click', () => void this.openBilling('pro'));
    this.elements.accountManage.addEventListener('click', () => void this.openBilling());
    this.elements.accountSignOut.addEventListener('click', () => void this.signOut());
    for (const key of ['anthropicApiKey', 'claudeGatewayUrl', 'claudeGatewayToken'] as const) {
      this.elements[key].addEventListener('change', () => this.updateClaudeFields());
    }

    Object.keys(this.elements).forEach(key => {
      if (!NON_SETTING_ELEMENT_KEYS.includes(key)) {
        (this.elements[key as keyof PopupElements] as HTMLElement).addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });
  }

  /** The last Claude failure the service worker recorded (cleared when Claude works again). */
  private async showClaudeError(): Promise<void> {
    try {
      const { claudeError } = (await chrome.storage.session.get('claudeError')) as { claudeError?: { status: number | null; message: string } };
      if (claudeError && !this.elements.claudeStatus.textContent) {
        this.elements.claudeStatus.textContent = `Claude error${claudeError.status ? ` (${claudeError.status})` : ''}: ${claudeError.message}`.slice(0, 240);
      }
    } catch {
      // no session storage (tests) or not available: nothing to show
    }
  }

  /** Key vs gateway fields, the gateway URL check, and "(needs Claude access)" on Claude modes. */
  private updateClaudeFields(): boolean {
    const gateway = this.elements.claudeAccess.value === 'gateway';
    const subscription = this.elements.claudeAccess.value === 'subscription';
    this.elements.anthropicKeyGroup.classList.toggle('hidden', gateway || subscription);
    this.elements.claudeGatewayGroup.classList.toggle('hidden', !gateway);
    const url = this.elements.claudeGatewayUrl.value.trim();
    const urlOk = !url || validateGatewayUrl(url) !== null;
    this.elements.claudeStatus.textContent =
      gateway && !urlOk ? 'Gateway URL must start with https:// (http:// only for localhost).' : '';
    const hasClaude = subscription ? this.signedIn : gateway ? !!url && urlOk && !!this.elements.claudeGatewayToken.value : !!this.elements.anthropicApiKey.value;
    for (const option of this.elements.engineMode.options) {
      const needsClaude = option.value !== 'fast';
      option.textContent = MODE_LABELS[option.value] + (needsClaude && !hasClaude ? ' (needs Claude access)' : '');
    }
    return urlOk;
  }

  private updateApiKeyVisibility() {
    const isDeepL = this.elements.translationProvider.value === 'deepl';
    const isSubscription = this.elements.translationProvider.value === 'subscription';
    this.elements.googleApiKeyGroup.classList.toggle('hidden', isDeepL || isSubscription);
    this.elements.deeplApiKeyGroup.classList.toggle('hidden', !isDeepL);
  }

  async loadSettings() {
    try {
      const settings = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as ExtensionSettings;
      const secrets = await getSecrets();

      this.elements.sourceLanguage.value = settings.sourceLanguage;
      this.elements.targetLanguage.value = settings.targetLanguage;
      this.elements.subtitleStyle.value = settings.subtitleStyle;
      this.elements.fontSize.value = settings.fontSize;
      this.elements.translationProvider.value = settings.translationProvider;
      this.elements.googleTranslateApiKey.value = secrets.googleTranslateApiKey;
      this.elements.deeplApiKey.value = secrets.deeplApiKey;
      this.elements.subtitleLanguage.value = settings.subtitleLanguage;
      this.elements.engineMode.value = settings.translationEngineMode;
      this.elements.claudeModel.value = settings.claudeModel;
      this.elements.claudeAccess.value = settings.claudeAccess;
      this.elements.claudeGatewayUrl.value = settings.claudeGatewayUrl;
      this.elements.claudeGatewayAuth.value = settings.claudeGatewayAuth;
      this.elements.anthropicApiKey.value = secrets.anthropicApiKey;
      this.elements.claudeGatewayToken.value = secrets.claudeGatewayToken;
      this.elements.themeChoice.value = settings.theme ?? 'system';
      this.stopTheme();
      this.stopTheme = applyTheme(document.documentElement, (settings.theme ?? 'system') as ThemeChoice);
      this.updateApiKeyVisibility();
      this.updateClaudeFields();
      this.renderTranslateWith();
      this.renderEngineSummary();
      this.renderCaption();
      await this.showClaudeError();

      this.updateToggleButton();


    } catch (error) {
      console.error('Failed to load settings:', error);
      this.showStatus('Failed to load settings', 'error');
      this.setDefaultValues();
    }
  }

  private setDefaultValues() {
    this.elements.sourceLanguage.value = 'auto';
    this.elements.targetLanguage.value = 'en';
    this.elements.subtitleStyle.value = 'bottom';
    this.elements.fontSize.value = 'medium';
    this.elements.translationProvider.value = 'google';
    this.elements.googleTranslateApiKey.value = '';
    this.elements.deeplApiKey.value = '';
    this.updateApiKeyVisibility();
    this.isActive = false;
    this.updateToggleButton();
  }

  async saveSettings() {
    try {
      const gatewayUrlOk = this.updateClaudeFields();
      const settings: Record<string, string> = {
        sourceLanguage: this.elements.sourceLanguage.value,
        targetLanguage: this.elements.targetLanguage.value,
        subtitleStyle: this.elements.subtitleStyle.value,
        fontSize: this.elements.fontSize.value,
        translationProvider: this.elements.translationProvider.value,
        googleTranslateApiKey: this.elements.googleTranslateApiKey.value,
        deeplApiKey: this.elements.deeplApiKey.value,
        subtitleLanguage: this.elements.subtitleLanguage.value,
        translationEngineMode: this.elements.engineMode.value,
        claudeModel: this.elements.claudeModel.value,
        claudeAccess: this.elements.claudeAccess.value,
        claudeGatewayAuth: this.elements.claudeGatewayAuth.value,
        theme: this.elements.themeChoice.value,
        anthropicApiKey: this.elements.anthropicApiKey.value,
        claudeGatewayToken: this.elements.claudeGatewayToken.value
      };
      // An unacceptable gateway URL is never stored (the token must only go to a safe endpoint).
      if (gatewayUrlOk) settings.claudeGatewayUrl = validateGatewayUrl(this.elements.claudeGatewayUrl.value) ?? '';

      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: settings
      });

      this.showStatus('Settings saved', 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showStatus('Failed to save settings', 'error');
    }
  }

  async toggleSubtitles() {
    try {
      if (!this.isActive && this.subtitleModeRunning) {
        await this.stopSubtitleMode(); // one mode at a time
      }
      this.isActive = !this.isActive;
      this.updateToggleButton();

      const tab = await getTargetTab();

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id !== 'number') {
        throw new Error('Active tab does not have a valid id');
      }
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_SUBTITLES'
      });
      if (typeof response?.active === 'boolean' && response.active !== this.isActive) {
        // The content script couldn't start capture; it shows the reason on the page.
        this.isActive = response.active;
        this.updateToggleButton();
        this.showStatus('Could not start live captions. The page says why.', 'error');
        return;
      }

      this.showStatus(
        this.isActive ? 'Live captions on' : 'Live captions off',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle live captions:', error);
      this.showStatus('Could not switch live captions: ' + describeTabError(error), 'error');
      this.isActive = !this.isActive;
      this.updateToggleButton();
    }
  }

  async toggleScreenTranslation() {
    const wasScreenTranslating = this.isScreenTranslating;
    this.screenTranslateActionCount++;

    try {
      this.renderScreenTranslateState(wasScreenTranslating ? 'inactive' : 'armed');

      const tab = await getTargetTab();

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SCREEN_TRANSLATION'
        });
        if (response?.state) {
          this.renderScreenTranslateState(response.state);
        }
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      this.showStatus(
        this.isScreenTranslating ? 'Screen translation activated' : 'Screen translation deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle screen translation:', error);
      this.showStatus('Failed to toggle screen translation: ' + describeTabError(error), 'error');
      this.renderScreenTranslateState(wasScreenTranslating ? 'armed' : 'inactive');
    }
  }

  async refreshScreenTranslateState() {
    const actionCountAtStart = this.screenTranslateActionCount;
    try {
      const tab = await getTargetTab();

      if (!tab || typeof tab.id !== 'number') {
        this.renderScreenTranslateState('inactive');
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_SCREEN_TRANSLATE_STATE'
      });

      if (this.screenTranslateActionCount !== actionCountAtStart) return;
      this.renderScreenTranslateState(response?.state ?? 'inactive');
    } catch (error) {
      if (this.screenTranslateActionCount !== actionCountAtStart) return;
      this.renderScreenTranslateState('inactive');
    }
  }

  renderScreenTranslateState(state: 'inactive' | 'armed' | 'ready-to-redraw') {
    this.isScreenTranslating = state !== 'inactive';
    this.screenState = state;
    this.renderCaption();
    this.updateScreenTranslateButton();

    if (state === 'inactive') {
      this.elements.screenTranslateStatus.classList.add('hidden');
      this.elements.drawNewBoxButton.classList.add('hidden');
      return;
    }

    this.elements.screenTranslateStatus.textContent = state === 'armed'
      ? 'Drag a box around text to translate.'
      : 'Translated. Draw another box to translate more.';
    this.elements.screenTranslateStatus.className = 'message';
    this.elements.drawNewBoxButton.classList.toggle('hidden', state !== 'ready-to-redraw');
  }

  async drawNewBox() {
    this.screenTranslateActionCount++;
    try {
      const tab = await getTargetTab();

      if (!tab || typeof tab.id !== 'number') {
        throw new Error('No active tab found');
      }

      await chrome.tabs.sendMessage(tab.id, {
        type: 'DRAW_NEW_BOX'
      });

      this.renderScreenTranslateState('armed');
    } catch (error) {
      console.error('Failed to draw new box:', error);
      this.showStatus('Failed to draw new box: ' + describeTabError(error), 'error');
    }
  }

  updateToggleButton() {
    const button = this.elements.toggleButton;

    if (this.isActive) {
      button.textContent = 'Stop live captions';
      button.classList.add('active');
    } else {
      button.textContent = 'Start live captions';
      button.classList.remove('active');
    }
    this.renderCaption?.();
  }

  updateScreenTranslateButton() {
    const button = this.elements.screenTranslateButton;

    if (this.isScreenTranslating) {
      button.textContent = 'Stop translating';
      button.classList.add('active');
    } else {
      button.textContent = 'Screen Translate';
      button.classList.remove('active');
    }
  }

  showStatus(message: string, type = 'success') {
    const statusElement = this.elements.status;

    statusElement.textContent = message;
    statusElement.className = `message ${type}`;
    statusElement.classList.remove('hidden');

    setTimeout(() => {
      statusElement.classList.add('hidden');
    }, 3000);
  }

  async checkPermissions() {
    try {
      const hasPermissions = await chrome.permissions.contains({
        permissions: ['tabCapture'],
        origins: ['<all_urls>']
      });

      if (!hasPermissions) {
        this.showStatus('Missing required permissions', 'warning');
        return false;
      }

      return true;
    } catch (error) {
      console.error('Permission check failed:', error);
      return false;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
