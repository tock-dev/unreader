(function () {
  const settingKey = 'unreader-neko-enabled';
  const spriteKey = 'unreader-neko-sprite';
  const defaultAnimations = [
    [28], [25, 28], [26, 27], [29], [30, 31], [0], [1, 2], [9, 10], [13, 14], [5, 6],
    [15, 16], [3, 4], [11, 12], [7, 8], [17, 18], [23, 24], [21, 22], [19, 20],
  ];
  let script;
  let createPending = false;

  function getNekoPet(spriteData) {
    if (!spriteData) return null;
    try {
      const frames = JSON.parse(spriteData);
      if (Array.isArray(frames) && frames.length === 32 && frames.every(isPngData)) {
        return { sprites: frames, animations: defaultAnimations };
      }
      if (frames && frames.version === 2 && Array.isArray(frames.frames) && Array.isArray(frames.actions)) {
        const animations = defaultAnimations.map(function (action) { return action.slice(); });
        frames.actions.forEach(function (action) {
          if (action && action.state >= 0 && action.state < animations.length && Array.isArray(action.frames) && action.frames.length) {
            animations[action.state] = action.frames;
          }
        });
        return { sprites: frames.frames, animations: animations };
      }
    } catch (error) {}
    if (spriteData.indexOf('data:image/png;base64,') === 0) {
      return { sprites: Array(32).fill(spriteData), animations: defaultAnimations };
    }
    return null;
  }

  function isPngData(value) {
    return typeof value === 'string' && value.indexOf('data:image/png;base64,') === 0;
  }

  function installAnimationSupport(neko) {
    neko.animationFrames = defaultAnimations;
    neko.updateSprite = function () {
      if (!this.spriteImages.length) return;
      const sequence = this.animationFrames[this.state] || this.animationTable[this.state];
      if (!sequence || !sequence.length) return;
      const step = this.state === 4 ? this.tickCount >> 2 : this.tickCount;
      const frameIndex = sequence[step % sequence.length];
      const image = this.element.querySelector('img');
      if (image && this.spriteImages[frameIndex]) image.src = this.spriteImages[frameIndex];
    };
  }

  function applyPetToNeko(neko, pet) {
    if (!pet) return;
    installAnimationSupport(neko);
    neko.animationFrames = pet.animations;
    neko.setSprites(pet.sprites);
  }

  function createNeko() {
    if (!document.body) {
      if (createPending) return;
      createPending = true;

      function createWhenReady() {
        if (!document.body) {
          setTimeout(createWhenReady, 0);
          return;
        }
        createPending = false;
        if (localStorage.getItem(settingKey) !== 'false' && window.createNeko) createNeko();
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createWhenReady);
      } else {
        setTimeout(createWhenReady, 0);
      }
      return;
    }

    const neko = window.createNeko();
    const pet = getNekoPet(localStorage.getItem(spriteKey));
    installAnimationSupport(neko);
    if (pet) applyPetToNeko(neko, pet);
    if (!neko.running) neko.start();
    window.neko = neko;
  }

  window.applyNekoSprite = function (spriteData) {
    const pet = getNekoPet(spriteData);
    if (pet && window.neko) applyPetToNeko(window.neko, pet);
  };

  window.setNekoEnabled = function (enabled) {
    localStorage.setItem(settingKey, String(enabled));
    if (!enabled) {
      if (window.neko) {
        const neko = window.neko;
        window.neko = null;
        neko.stop();
        neko.destroy();
      }
      return;
    }

    if (window.neko) {
      if (window.neko.element && window.neko.element.parentNode) {
        if (!window.neko.running) window.neko.start();
        return;
      }
      window.neko = null;
    }
    if (window.createNeko) {
      createNeko();
      return;
    }
    if (script) return;

    script = document.createElement('script');
    script.src = 'neko.js';
    script.onload = function () {
      script = null;
      if (localStorage.getItem(settingKey) !== 'false' && window.createNeko) {
        createNeko();
      }
    };
    script.onerror = function () {
      script = null;
    };
    document.head.appendChild(script);
  };

  if (localStorage.getItem(settingKey) !== 'false') {
    window.setNekoEnabled(true);
  }
})();
