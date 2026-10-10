//! DON'T FORGET TO CHANGE TO `false` BEFORE PUSHING
const DEBUG = false;
const DO_LOGGING = true;
var BACKEND_URL = DEBUG
  ? 'http://192.168.100.64:80'
  : window.location.origin;
var WS_URL = DEBUG
  ? 'ws://192.168.100.64:80'
  : window.location.origin.replace('https', 'wss').replace('http', 'ws');

function log(...args) {
  if (DO_LOGGING) console.log(`[CLIENT]`, ...args);
}

function hide(selector) {
  document.querySelector(selector).classList.add('hide');
}

function show(selector) {
  document.querySelector(selector).classList.remove('hide');
}

function profilePictureDataUrl(imageData) {
  return typeof imageData === 'string' && imageData.length <= 700000 && /^[A-Za-z0-9+/]+={0,2}$/.test(imageData)
    ? `data:image/png;base64,${imageData}`
    : '';
}

function profilePictureDimensions(imageData) {
  if (!profilePictureDataUrl(imageData)) return 0;
  try {
    const bytes = atob(imageData.slice(0, 32));
    return bytes.length >= 24 ? new DataView(Uint8Array.from(bytes, (char) => char.charCodeAt(0)).buffer).getUint32(16) : 0;
  } catch (error) {
    return 0;
  }
}

function createProfilePicture(imageData, size) {
  const image = document.createElement('img');
  const displaySize = size === undefined ? 24 : size;
  image.className = 'profile-picture';
  image.alt = profilePictureDataUrl(imageData) ? 'Profile picture' : '';
  image.width = image.height = displaySize;
  image.style.width = image.style.height = displaySize + 'px';
  image.style.imageRendering = 'pixelated';
  image.src = profilePictureDataUrl(imageData) || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  return image;
}

function setupProfilePictureEditor(imageData = '') {
  const canvas = document.getElementById('edit-picture-canvas');
  const size = document.getElementById('edit-picture-size');
  const red = document.getElementById('edit-picture-red');
  const green = document.getElementById('edit-picture-green');
  const blue = document.getElementById('edit-picture-blue');
  const colorPreview = document.getElementById('edit-picture-color-preview');
  const file = document.getElementById('edit-picture-file');
  const clear = document.getElementById('edit-picture-clear');
  const ctx = canvas.getContext('2d');
  let selectedColor = '#000000';
  let original = document.createElement('canvas');
  let hasOriginal = false;
  const updateColor = () => {
    const channels = [red, green, blue].map((input) => Math.max(0, Math.min(255, Number(input.value) || 0)));
    selectedColor = 'rgb(' + channels.join(',') + ')';
    colorPreview.style.backgroundColor = selectedColor;
    ['red', 'green', 'blue'].forEach((name, index) => {
      document.getElementById('edit-picture-' + name + '-value').textContent = channels[index];
    });
  };
  [red, green, blue].forEach((input) => input.oninput = updateColor);
  updateColor();
  const resize = (width, height, preserve) => {
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
    if (preserve) ctx.drawImage(preserve, 0, 0, width, height);
    canvas.parentElement.style.setProperty('--pixel-cell-size', (256 / width) + 'px');
  };
  const remember = () => {
    original = document.createElement('canvas');
    original.width = canvas.width;
    original.height = canvas.height;
    original.getContext('2d').drawImage(canvas, 0, 0);
    hasOriginal = true;
  };
  resize(Number(size.value), Number(size.value));
  size.onchange = () => resize(Number(size.value), Number(size.value), hasOriginal ? original : canvas);

  let drawing = false;
  const paint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width);
    const y = Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    ctx.fillStyle = selectedColor;
    ctx.fillRect(x, y, 1, 1);
    remember();
  };
  canvas.onpointerdown = (event) => { drawing = true; canvas.setPointerCapture(event.pointerId); paint(event); };
  canvas.onpointermove = (event) => { if (drawing) paint(event); };
  canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; };
  clear.onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); remember(); };

  let picker = file.parentElement;
  if (!picker.classList.contains('profile-picture-file')) {
    const wrapper = document.createElement('span');
    wrapper.className = 'profile-picture-file';
    file.parentNode.insertBefore(wrapper, file);
    wrapper.appendChild(file);
    file.classList.add('profile-picture-file-input');
    const browse = document.createElement('button');
    browse.type = 'button';
    browse.className = 'paper-btn';
    browse.textContent = 'CHOOSE IMAGE';
    browse.onclick = () => file.click();
    const name = document.createElement('span');
    name.textContent = 'No image selected';
    name.setAttribute('role', 'status');
    wrapper.appendChild(browse);
    wrapper.appendChild(name);
  }
  picker = file.parentElement;
  picker.querySelector('button').onclick = () => file.click();
  file.onchange = () => {
    const selected = file.files[0];
    if (!selected) return;
    picker.querySelector('[role="status"]').textContent = selected.name;
    const image = new Image();
    image.onload = () => {
      const dimensions = [8, 16, 32, 64];
      if (image.naturalWidth === image.naturalHeight && dimensions.indexOf(image.naturalWidth) !== -1) {
        size.value = String(image.naturalWidth);
        resize(image.naturalWidth, image.naturalHeight);
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      remember();
      URL.revokeObjectURL(image.src);
      file.value = '';
    };
    image.onerror = () => { URL.revokeObjectURL(image.src); unAlert('Could not import that image.'); };
    image.src = URL.createObjectURL(selected);
  };

  if (imageData) {
    const image = new Image();
    image.onload = () => {
      const dimensions = [8, 16, 32, 64];
      const nativeSize = image.naturalWidth === image.naturalHeight && dimensions.indexOf(image.naturalWidth) !== -1 ? image.naturalWidth : 16;
      size.value = String(nativeSize);
      resize(nativeSize, nativeSize);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      remember();
    };
    image.src = `data:image/png;base64,${imageData}`;
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    remember();
  }
}

function getProfilePictureBase64() {
  const canvas = document.getElementById('edit-picture-canvas');
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  if (!pixels.some((value, index) => index % 4 === 3 && value !== 0)) return '';
  return canvas.toDataURL('image/png').split(',')[1];
}

function showProfilePicture(imageData, fallback) {
  const element = document.getElementById('info-avatar');
  element.replaceChildren();
  if (!profilePictureDataUrl(imageData)) return;
  const image = document.createElement('img');
  image.src = profilePictureDataUrl(imageData);
  image.alt = 'Profile picture';
  image.width = image.height = 64;
  image.style.width = image.style.height = image.width + 'px';
  image.style.imageRendering = 'pixelated';
  element.appendChild(image);
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

  const savedDarkMode = localStorage.getItem('unreader-darkmode');
  if (
    savedDarkMode === 'enabled' ||
    (savedDarkMode === null && localStorage.getItem('dark-mode') === 'true')
  ) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
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

function installSharedThemeStyles() {
  applySavedPreferences();
  if (!document.getElementById('shared-theme-styles')) {
    const themeStyles = document.createElement('link');
    themeStyles.id = 'shared-theme-styles';
    themeStyles.rel = 'stylesheet';
    themeStyles.href = 'theme.css';
    document.head.appendChild(themeStyles);
  }
}

document.addEventListener('DOMContentLoaded', installSharedThemeStyles);

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
