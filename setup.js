// The popup and offscreen document can't show a permission prompt, so this
// visible page asks once for the extension's origin. The grant is what makes
// enumerateDevices() return output device names and usable IDs.
const statusEl = document.getElementById("status");

navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    statusEl.textContent =
      "Done, you can close this tab. Open the popup on the tab you want to route.";
  })
  .catch((e) => {
    // Chrome doesn't prompt again after a block, so point at the setting.
    statusEl.textContent = `Microphone access wasn't granted (${e?.name}). Allow the microphone from the address bar, then reload this page.`;
  });
