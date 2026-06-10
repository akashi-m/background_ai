export async function openCamera(): Promise<HTMLVideoElement> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  })
  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  await video.play()
  return video
}

// Камера запрещена/не найдена → инструкция; остальное (например, не загрузился
// ассет) → общее сообщение с текстом ошибки (там будет имя файла).
export function showFatalError(err: unknown): void {
  const overlay = document.getElementById('overlay')!
  overlay.style.display = 'flex'
  const isCamera = err instanceof DOMException &&
    (err.name === 'NotAllowedError' || err.name === 'NotFoundError')
  const title = isCamera ? 'Нет доступа к камере' : 'Не удалось запуститься'
  const hint = isCamera
    ? 'Разрешите доступ к камере в настройках браузера и перезагрузите страницу.'
    : 'Подробности ниже — проверьте консоль и наличие файлов в public/assets/.'
  overlay.innerHTML =
    `<div><h2>${title}</h2><p>${hint}</p>` +
    `<p style="opacity:.6">${err instanceof Error ? err.message : String(err)}</p></div>`
}
