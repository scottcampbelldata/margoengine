const compatLight = !navigator.gpu || new URLSearchParams(location.search).get('backend') === 'webgl2';
    document.getElementById(compatLight ? 'compat-light' : 'native-light').media = 'all';
