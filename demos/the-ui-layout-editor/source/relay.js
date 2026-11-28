export const reference = [420, 368];

export const initialSource = {
  markup: '<column id="relay" class="relay" anchor="center" gap="9">\n' +
    '  <row id="heading" class="head">\n' +
    '    <label id="network" size="13" color="#e8c384">COASTAL RELAY</label>\n' +
    '    <label id="link" size="13" color="#92d9be">● LINK ACTIVE</label>\n' +
    '  </row>\n' +
    '  <label id="station" size="40">Station 07</label>\n' +
    '  <label id="location" size="15" color="#b5cac0">East breakwater / Channel 16</label>\n' +
    '  <column id="readout" class="readout" gap="8">\n' +
    '    <row id="meter-header" class="head">\n' +
    '      <label id="signal-name" size="13" color="#b5cac0">SIGNAL STRENGTH</label>\n' +
    '      <label id="signal-number" size="13" color="#92d9be">VHF</label>\n' +
    '    </row>\n' +
    '    <progress id="signal" class="signal" value=".87"></progress>\n' +
    '  </column>\n' +
    '  <row id="actions" class="actions" gap="12">\n' +
    '    <button id="scan" variant="primary">Scan band</button>\n' +
    '    <toggle id="record" checked="true">Log</toggle>\n' +
    '  </row>\n' +
    '</column>',
  styles: '.relay { width: 354; padding: 20; background: surface; border: true; radius: 13; }\n' +
    '.head { justify: space-between; align: center; }\n' +
    '.readout { background: #172d2c; padding: 13 11; radius: 8; }\n' +
    '.signal { height: 8; color: primary; radius: 4; }\n' +
    '.actions { align: center; }\n' +
    '.actions > button { grow: 1; height: 42; }\n',
};

export const widgetTypes = {
  label: { name: 'Label', text: 'Signal note', attributes: { size: '16', color: 'accent' } },
  button: { name: 'Button', text: 'Run check', attributes: { height: '38', variant: 'primary' } },
  toggle: { name: 'Toggle', text: 'Telemetry', attributes: { checked: 'true' } },
  slider: { name: 'Slider', text: 'Sensitivity', attributes: { value: '.65', height: '30' } },
  column: { name: 'Stack', attributes: { padding: '10', gap: '7', background: '#34514c', border: 'true' } },
};

export const containers = new Set(['panel','row','column']);
export const textWidgets = new Set(['label','button','toggle','slider','progress','health']);
export const numericWidgets = new Set(['slider','progress','health']);

export const themeOptions = {
  name: 'relay',
  colors: {
    background: '#132d30', surface: '#213b39', surfaceRaised: '#35504b', surfaceSunken: '#172d2c',
    border: '#7c9a8b', text: '#f5f1da', textMuted: '#b5cac0',
    primary: '#a9ddbc', onPrimary: '#15352d', accent: '#e8c384', onAccent: '#3a3025',
    success: '#92d9be', focus: '#ffd49b', shadow: '#14272788',
  },
  fontSize: { small: 13, body: 16, large: 22, title: 33, display: 43 },
  spacing: 7,
  radius: 7,
  shadowBlur: 0,
};
