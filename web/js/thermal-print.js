// STEP 7 of the fashion-retail evolution: ESC/POS thermal receipt printing via WebUSB,
// where the browser/OS supports it (desktop Chrome/Edge, Android Chrome -- WebUSB is not
// supported on iOS Safari, desktop Safari, or Firefox on any platform; the button this
// backs is only ever shown when isThermalPrintAvailable() is true).
//
// UNTESTED AGAINST REAL HARDWARE -- no thermal printer was available in this environment.
// The command bytes below follow the standard ESC/POS spec (ESC @ to initialize, GS V to
// cut), and the WebUSB handshake (open -> select configuration -> claim interface -> find
// the OUT endpoint -> transferOut) is the documented pattern for talking to a USB printer
// from a browser, but a specific printer model may need a different endpoint or vendor-
// specific initialization. Try it against the real printer before relying on it, and expect
// to adjust device selection/endpoint logic for that model.

export function isThermalPrintAvailable() {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

const ESC = 0x1b;
const GS = 0x1d;

function buildEscPosReceipt(text) {
  const encoder = new TextEncoder();
  const bytes = [];
  bytes.push(ESC, 0x40); // initialize printer
  bytes.push(...encoder.encode(text));
  bytes.push(0x0a, 0x0a, 0x0a); // feed a few lines before cutting
  bytes.push(GS, 0x56, 0x00); // full cut
  return new Uint8Array(bytes);
}

export async function printThermalReceipt(text) {
  if (!isThermalPrintAvailable()) {
    throw new Error('WebUSB is not available in this browser -- thermal printing needs desktop Chrome/Edge or Android Chrome.');
  }

  const device = await navigator.usb.requestDevice({ filters: [] }); // user picks their printer from the OS/browser prompt
  await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }
  const iface = device.configuration.interfaces[0];
  await device.claimInterface(iface.interfaceNumber);

  const endpoint = iface.alternate.endpoints.find((e) => e.direction === 'out');
  if (!endpoint) {
    await device.close();
    throw new Error('No USB OUT endpoint found on this device -- it may not be an ESC/POS printer, or needs a different interface.');
  }

  const data = buildEscPosReceipt(text);
  await device.transferOut(endpoint.endpointNumber, data);
  await device.close();
}
