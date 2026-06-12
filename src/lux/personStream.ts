// Клиент capture-сервиса: WebRTC-видео (SBS-кадр) + WS-телеметрия.
// Реконнект с backoff БЕСКОНЕЧНО (capture может перезапускаться). Статус наружу:
// connecting → live → (stale считает потребитель по age) → down → connecting…

import * as THREE from 'three'

import { nextBackoffMs } from './backoff'
import { parseTelemetry, type Telemetry } from './telemetry'

export type StreamStatus = 'connecting' | 'live' | 'down'

export class PersonStream {
  status: StreamStatus = 'connecting'
  telemetry: Telemetry | null = null
  badMessages = 0
  texture: THREE.VideoTexture | null = null
  /** Аспект SBS-кадра (ширина/2 / высота); null до первого кадра. */
  videoAspect: number | null = null

  private video = document.createElement('video')
  private pc: RTCPeerConnection | null = null
  private ws: WebSocket | null = null
  private lastTelemetryAt = 0
  private attempt = 0
  private stopped = false
  /** Защита от двойного scheduleReconnect: таймер уже запланирован — пропускаем. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private baseUrl: string) {
    this.video.autoplay = true
    this.video.muted = true
    this.video.playsInline = true
  }

  start(): void {
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    // Гард: очистить таймер реконнекта если он ещё висит.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.teardown()
  }

  /** Секунды с последнего телеметрия-сообщения (для stale-логики опыта). */
  telemetryAgeSec(nowMs: number): number {
    return this.lastTelemetryAt === 0 ? Infinity : (nowMs - this.lastTelemetryAt) / 1000
  }

  /** Обновить производные поля видео (звать раз в кадр рендера). */
  tick(): void {
    if (this.texture && this.video.videoWidth > 0) {
      this.videoAspect = this.video.videoWidth / 2 / this.video.videoHeight
    }
  }

  private teardown(): void {
    this.pc?.close()
    this.pc = null
    this.ws?.close()
    this.ws = null
    this.texture?.dispose()
    this.texture = null
    this.videoAspect = null
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    // Гард: если таймер уже запланирован — не создаём второй.
    // Сценарий двойного срабатывания: pc.onconnectionstatechange('failed') →
    // teardown() закрывает ws → ws.onclose → scheduleReconnect() повторно.
    if (this.reconnectTimer !== null) return
    this.status = 'down'
    this.teardown()
    const delay = nextBackoffMs(this.attempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.status = 'connecting'
    try {
      // --- WebRTC ---
      const pc = new RTCPeerConnection()
      this.pc = pc
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.ontrack = (e) => {
        if (pc !== this.pc) return
        this.video.srcObject = new MediaStream([e.track])
        this.texture = new THREE.VideoTexture(this.video)
        // colorSpace не задаём: сырой sRGB камеры — то, что нужно (см. v1)
      }
      pc.onconnectionstatechange = () => {
        // Гард: событие старого соединения не должно трогать новое.
        if (pc !== this.pc) return
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          this.scheduleReconnect()
        }
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const resp = await fetch(`${this.baseUrl}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription!.sdp, type: pc.localDescription!.type }),
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) throw new Error(`offer: HTTP ${resp.status}`)
      await pc.setRemoteDescription(await resp.json())

      // --- WS-телеметрия ---
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws'
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      ws.onmessage = (e) => {
        // Гард: событие старого соединения не должно трогать новое.
        if (ws !== this.ws) return
        try {
          const t = parseTelemetry(JSON.parse(e.data as string))
          if (t) {
            this.telemetry = t
            this.lastTelemetryAt = performance.now()
            this.status = 'live'
            this.attempt = 0 // успешная связь — сбрасываем backoff
          } else {
            this.badMessages++
          }
        } catch {
          this.badMessages++
        }
      }
      ws.onclose = () => {
        // Гард: событие старого соединения не должно трогать новое.
        if (ws !== this.ws) return
        this.scheduleReconnect()
      }
      ws.onerror = () => { /* за ошибкой следует close — реконнект там */ }
    } catch {
      this.scheduleReconnect()
    }
  }
}
