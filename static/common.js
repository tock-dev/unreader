//! DON'T FORGET TO CHANGE TO `false` BEFORE PUSHING
const DEBUG = false;
const DO_LOGGING = true;
var BACKEND_URL = DEBUG
  ? 'http://192.168.100.64:80'
  : 'https://unreader-v4yf.onrender.com';
var WS_URL = DEBUG
  ? 'ws://192.168.100.64:80'
  : 'wss://unreader-v4yf.onrender.com';

function log(...args) {
  if (DO_LOGGING) console.log(`[CLIENT]`, ...args);
}

function hide(selector) {
  document.querySelector(selector).classList.add('hide');
}

function show(selector) {
  document.querySelector(selector).classList.remove('hide');
}

function applySavedPreferences() {
  if (
    localStorage.getItem('unreader-token') &&
    !localStorage.getItem('token')
  ) {
    localStorage.setItem('token', localStorage.getItem('unreader-token'));
  }
  if (
    localStorage.getItem('unreader-username') &&
    !localStorage.getItem('username')
  ) {
    localStorage.setItem('username', localStorage.getItem('unreader-username'));
  }
  if (
    localStorage.getItem('token') &&
    !localStorage.getItem('unreader-token')
  ) {
    localStorage.setItem('unreader-token', localStorage.getItem('token'));
  }
  if (
    localStorage.getItem('username') &&
    !localStorage.getItem('unreader-username')
  ) {
    localStorage.setItem('unreader-username', localStorage.getItem('username'));
  }

  if (localStorage.getItem('unreader-darkmode') === 'enabled') {
    document.body.classList.add('dark-mode');
  }
  const savedContrast = localStorage.getItem('unreader-contrast') || 'normal';
  if (savedContrast !== 'normal') {
    document.body.classList.add(`contrast-${savedContrast}`);
  }
  const savedFont = localStorage.getItem('unreader-font') || 'sans';
  if (savedFont === 'mono') {
    document.documentElement.style.setProperty('--body-font', 'monospace');
    document.body.style.fontFamily = 'monospace';
  }
}

function parseMarkdownForKindle(text) {
  if (!text) return '';
  // replace bold text: '**text**' -> '<strong>text</strong>'
  text = text.replace(
    /([\*_])([\*_](.*?)[\*_])([\*_])/g,
    '<strong>$2</strong>',
  );
  // replace italic text: '*text*' -> '<i>text</i>'
  text = text.replace(/([\*_])(.*?)([\*_])/g, '<i>$2</i>');
  // replace links: '[text](url)' -> '<a href="url">text</a>'
  text = text.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
  // replace images: '![alt text](url)' -> '<img src="url" alt="alt text">'
  text = text.replace(/\!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1">');
  // replace headers: # H1 -> <h1>H1</h1>
  text = text.replace(/\#{1} (.*?)/g, '<h1>$1</h1>');
  text = text.replace(/\#{2} (.*?)/g, '<h2>$1</h2>');
  text = text.replace(/\#{3} (.*?)/g, '<h3>$1</h3>');
  text = text.replace(/\#{4} (.*?)/g, '<h4>$1</h4>');
  text = text.replace(/\#{5} (.*?)/g, '<h5>$1</h5>');
  text = text.replace(/\#{6} (.*?)/g, '<h6>$1</h6>');
  // replace unordered lists: '- item' -> '<li>item</li>'
  text = text.replace(/^(-|\*) (.*?)/g, '<li>$2</li>');
  // replace ordered lists: '1. item' -> '<li>item</li>'
  text = text.replace(/^\d\. (.*?)/g, '<li>$1</li>');
  // replace code blocks: '```code```' -> '<pre><code>code</code></pre>'
  text = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // replace inline code: '`code`' -> '<code>code</code>'
  text = text.replace(/`(.*?)`/g, '<code>$1</code>');
  // replace blockquotes: '> quote' -> '<blockquote>quote</blockquote>'
  text = text.replace(/\>(.*?)/g, '<blockquote>$1</blockquote>');
  // replace horizontal rules: '---' -> '<hr>'
  text = text.replace(/\-\-\- /g, '<hr>');
  // replace strikethrough: '~text~' -> '<del>text</del>'
  text = text.replace(/~(.*?)~/g, '<del>$1</del>');
  return text;
}

function parseMarkup(text) {
  if (!text) return '';
  const escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (navigator.userAgent.toLowerCase().includes('kindle')) {
    return DOMPurify.sanitize(text);
    // return DOMPurify.sanitize(parseMarkdownForKindle(escaped));
  }
  return DOMPurify.sanitize(marked.parse(escaped)).trim();
}

function censor(text) {
  const curses = [
    'fuck',
    'shit',
    'bitch',
    'pussy',
    'dildo',
    'dick',
    'penis',
    'vagina',
    'tit',
    'tits',
    'cock',
    'cunt',
    'sex',
    'porn',
    'boob',
    'pedo',
    'pedophile',
    'rape',
    'molest',
    'orgy',
    'nigger',
    'hitler',
    'nazis',
  ];
  for (let i = 0; i < curses.length; i++) {
    text = text.replace(
      new RegExp(curses[i], 'gi'),
      '█'.repeat(curses[i].length),
    );
  }
  return text;
}

function formatTimeToken(unixTimestamp) {
  if (!unixTimestamp) return 'MOMENTS AGO';
  var parsedNum = Number(unixTimestamp);
  if (isNaN(parsedNum)) return 'MOMENTS AGO';
  var d = new Date(parsedNum);
  return (
    d.toLocaleDateString() +
    ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

// Modal implementations
function createModalContainer() {
  const container = document.createElement('div');
  container.className = 'modal-overlay';
  document.body.appendChild(container);
  return container;
}

function unAlert(message) {
  return new Promise((resolve) => {
    const container = createModalContainer();
    container.innerHTML = `
      <div class="modal-content">
        <div class="modal-message">${message}</div>
        <div class="modal-buttons">
          <button class="modal-btn" id="modal-ok">OK</button>
        </div>
      </div>
    `;
    container.querySelector('#modal-ok').onclick = function () {
      document.body.removeChild(container);
      resolve();
    };
  });
}

function unConfirm(message) {
  return new Promise((resolve) => {
    const container = createModalContainer();
    container.innerHTML = `
      <div class="modal-content">
        <div class="modal-message">${message}</div>
        <div class="modal-buttons">
          <button class="modal-btn" id="modal-cancel">CANCEL</button>
          <button class="modal-btn" id="modal-ok">OK</button>
        </div>
      </div>
    `;
    container.querySelector('#modal-ok').onclick = function () {
      document.body.removeChild(container);
      resolve(true);
    };
    container.querySelector('#modal-cancel').onclick = function () {
      document.body.removeChild(container);
      resolve(false);
    };
  });
}

function unPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const container = createModalContainer();
    container.innerHTML = `
      <div class="modal-content">
        <div class="modal-message">${message}</div>
        <input type="text" class="modal-input" id="modal-input" value="${defaultValue}">
        <div class="modal-buttons">
          <button class="modal-btn" id="modal-cancel">CANCEL</button>
          <button class="modal-btn" id="modal-ok">OK</button>
        </div>
      </div>
    `;
    const input = container.querySelector('#modal-input');
    input.focus();
    input.onkeydown = function (e) {
      if (e.key === 'Enter') container.querySelector('#modal-ok').click();
    };
    container.querySelector('#modal-ok').onclick = function () {
      const value = input.value;
      document.body.removeChild(container);
      resolve(value);
    };
    container.querySelector('#modal-cancel').onclick = function () {
      document.body.removeChild(container);
      resolve(null);
    };
  });
}

// Global replacement of alert, confirm, prompt if needed
// But it's better to explicitly use unAlert, unConfirm, unPrompt
// and update calls to use await.
