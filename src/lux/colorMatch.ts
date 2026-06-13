// Цвет-матч фигуры под сцену (спека §2): перенос цветового каста и экспозиции
// среднего цвета фона на фигуру. Та же математика миррорится в шейдере фигуры
// (compositor personMat) — здесь эталон/тесты, на GPU uMean сэмплится без readback.

export interface ColorMatchConfig {
  cast: number      // сила переноса цветового каста 0..1
  exposure: number  // сила подгонки экспозиции 0..1
}

export interface ColorMatchUniforms {
  castMul: [number, number, number]
  expMul: number
}

const LUMA: [number, number, number] = [0.2126, 0.7152, 0.0722] // Rec.709

export function colorMatchUniforms(
  sceneMean: [number, number, number],
  cfg: ColorMatchConfig,
): ColorMatchUniforms {
  const luma = sceneMean[0] * LUMA[0] + sceneMean[1] * LUMA[1] + sceneMean[2] * LUMA[2]
  // хрома сцены = mean / luma (нормированный цвет, серый → (1,1,1)); защита от 0
  const chroma: [number, number, number] = luma > 1e-3
    ? [sceneMean[0] / luma, sceneMean[1] / luma, sceneMean[2] / luma]
    : [1, 1, 1]
  const castMul: [number, number, number] = [
    1 + cfg.cast * (chroma[0] - 1),
    1 + cfg.cast * (chroma[1] - 1),
    1 + cfg.cast * (chroma[2] - 1),
  ]
  // средне-серый (0.5) → без изменения; темнее → <1 (тушим), светлее → >1
  const expMul = 1 + cfg.exposure * (luma / 0.5 - 1)
  return { castMul, expMul }
}
