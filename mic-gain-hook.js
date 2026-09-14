(() => {
  if (!navigator.mediaDevices?.getUserMedia) return;

  const gainNodes = new Map(); // trackId -> GainNode
  let liveCount = 0;
  let currentGain = 1;
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );

  function notify(type) {
    window.postMessage({ __tac: true, type }, "*");
  }

  function wireTrack(track, ctx, destination) {
    gainNodes.set(track.id, { gainNode: destination.gainNode, ctx });
    liveCount++;
    if (liveCount === 1) notify("MIC_CAPTURE_STARTED");
    track.addEventListener("ended", () => {
      gainNodes.delete(track.id);
      liveCount--;
      if (liveCount === 0) notify("MIC_CAPTURE_STOPPED");
      destination.gainNode.disconnect();
      ctx.close().catch(() => {});
    });
  }

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await origGetUserMedia(constraints);
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return stream;

    const out = new MediaStream(stream.getVideoTracks());
    audioTracks.forEach((track) => {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const gainNode = ctx.createGain();
      gainNode.gain.value = currentGain;
      const dest = ctx.createMediaStreamDestination();
      source.connect(gainNode).connect(dest);
      wireTrack(track, ctx, { gainNode });
      out.addTrack(dest.stream.getAudioTracks()[0]);
    });
    return out;
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data?.__tac) return;
    if (event.data.type === "SET_MIC_GAIN") {
      currentGain = event.data.gain;
      gainNodes.forEach(({ gainNode }) => {
        gainNode.gain.value = currentGain;
      });
    }
  });
})();
