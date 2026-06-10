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
  const overlay = document.getElementById('overlay')
  if (!overlay) { console.error(err); return }
  overlay.style.display = 'flex'
  const isCamera = err instanceof DOMException &&
    (err.name === 'NotAllowedError' || err.name === 'NotFoundError')
  const titleText = isCamera ? 'Нет доступа к камере' : 'Не удалось запуститься'
  const hintText = isCamera
    ? 'Разрешите доступ к камере в настройках браузера и перезагрузите страницу.'
    : 'Подробности ниже — проверьте консоль и наличие файлов в public/assets/.'

  const container = document.createElement('div')

  const h2 = document.createElement('h2')
  h2.textContent = titleText
  container.appendChild(h2)

  const pHint = document.createElement('p')
  pHint.textContent = hintText
  container.appendChild(pHint)

  const pDetail = document.createElement('p')
  pDetail.style.opacity = '0.6'
  pDetail.textContent = err instanceof Error ? err.message : String(err)
  container.appendChild(pDetail)

  overlay.textContent = ''
  overlay.appendChild(container)
}
