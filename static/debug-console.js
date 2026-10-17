(function () {
  var pendingErrors = [];
  var ready = false;
  window.addEventListener('error', function (event) {
    if (!ready && pendingErrors.length < 20) {
      pendingErrors.push(event.message + ' (' + event.filename + ':' + event.lineno + ')');
    }
  });
  window.addEventListener('unhandledrejection', function (event) {
    if (!ready && pendingErrors.length < 20) {
      pendingErrors.push('Unhandled rejection: ' + String(event.reason));
    }
  });

  var script = document.createElement('script');
  script.src = 'eruda.js';
  script.onload = function () {
    var initialize = function () {
      if (!window.eruda) return;
      window.eruda.init({
        tool: ['console', 'elements', 'network', 'resources', 'info'],
        defaults: { displaySize: 50 }
      });
      var consoleTool = window.eruda.get('console');
      consoleTool.config.set('catchGlobalErr', true);
      consoleTool.config.set('displayIfErr', true);
      ready = true;
      pendingErrors.forEach(function (message) { consoleTool.error(message); });
      window.eruda.show('console');
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize);
    } else {
      initialize();
    }
  };
  document.head.appendChild(script);
}());
