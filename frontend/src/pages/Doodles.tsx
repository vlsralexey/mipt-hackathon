import styles from './Doodles.module.css'

/* Научные зарисовки по бокам стартового экрана: молекулы, атом, формулы, график.
   Рисованы от руки в SVG тем же оранжевым, что и здание МФТИ внизу. Украшение,
   поэтому скрыты от чтения с экрана. */

/** Узел молекулы: кружок с заливкой фона, чтобы связи не просвечивали. */
function Node({ x, y, r = 7 }: { x: number; y: number; r?: number }) {
  return <circle cx={x} cy={y} r={r} className={styles.node} />
}

/** Знак бесконечности: две петли вокруг точки (x, y). */
function infinity(x: number, y: number, s = 1) {
  const k = (v: number) => v * s
  return (
    `M ${x} ${y} C ${x + k(5)} ${y - k(8)} ${x + k(14)} ${y - k(8)} ${x + k(14)} ${y} ` +
    `C ${x + k(14)} ${y + k(8)} ${x + k(5)} ${y + k(8)} ${x} ${y} ` +
    `C ${x - k(5)} ${y - k(8)} ${x - k(14)} ${y - k(8)} ${x - k(14)} ${y} ` +
    `C ${x - k(14)} ${y + k(8)} ${x - k(5)} ${y + k(8)} ${x} ${y}`
  )
}

/* Обе группы в одной ширине viewBox (380), поэтому на экране у них один масштаб */

function LeftDoodles() {
  return (
    <svg className={`${styles.cluster} ${styles.left}`} viewBox="0 0 380 390" aria-hidden="true">
      {/* Молекула: кольцо из шести атомов и боковые цепочки */}
      <path d="M 58 80 L 98 58 L 136 82 L 134 124 L 94 146 L 56 122 Z" />
      <path d="M 98 58 L 102 20 M 136 82 L 176 72 M 134 124 L 160 158 M 56 122 L 24 142 M 58 80 L 24 62" />
      <Node x={58} y={80} r={7} />
      <Node x={98} y={58} r={7} />
      <Node x={136} y={82} r={7} />
      <Node x={134} y={124} r={7} />
      <Node x={94} y={146} r={7} />
      <Node x={56} y={122} r={7} />
      <Node x={102} y={20} r={5.5} />
      <Node x={176} y={72} r={6} />
      <Node x={160} y={158} r={5.5} />
      <Node x={24} y={142} r={5.5} />
      <Node x={24} y={62} r={6} />

      <text x="216" y="66" transform="rotate(-8 216 66)">2 + 2 = 4</text>

      {/* Атом: три орбиты и ядро. Сдвинут влево: правый нижний угол группы пустой,
          чтобы на невысоком окне рисунок не заходил под поле ввода */}
      <g transform="translate(232 176)">
        <ellipse rx="52" ry="19" />
        <ellipse rx="52" ry="19" transform="rotate(60)" />
        <ellipse rx="52" ry="19" transform="rotate(-60)" />
        <circle r="7" className={styles.solid} />
      </g>

      <path d="M 6 182 C 28 236 88 262 168 256" />
      <circle cx="32" cy="276" r="5" className={styles.solid} />
      <circle cx="196" cy="266" r="4" className={styles.solid} />
      <circle cx="352" cy="122" r="3.5" className={styles.solid} />

      {/* Теорема Пифагора внизу: левая группа заканчивается на той же высоте, что правая */}
      <text x="40" y="350" transform="rotate(-5 40 350)">
        a<tspan dy="-16" className={styles.sup}>2</tspan>
        <tspan dy="16"> + b</tspan>
        <tspan dy="-16" className={styles.sup}>2</tspan>
        <tspan dy="16"> = c</tspan>
        <tspan dy="-16" className={styles.sup}>2</tspan>
      </text>
      <circle cx="262" cy="372" r="4" className={styles.solid} />
    </svg>
  )
}

function RightDoodles() {
  return (
    <svg className={`${styles.cluster} ${styles.right}`} viewBox="0 0 380 390" aria-hidden="true">
      <text x="40" y="92" transform="rotate(-7 40 92)">
        E = mc
        <tspan dy="-18" className={styles.sup}>2</tspan>
      </text>
      <path d="M 34 172 C 74 158 116 142 162 126" />

      {/* График: оси со стрелками и парабола ветвями вниз */}
      <path d="M 284 214 L 272 42 M 261 58 L 272 40 L 286 55" />
      <path d="M 222 190 L 366 162 M 350 151 L 368 162 L 352 174" />
      <path d="M 294 154 C 302 90 332 86 346 150" />
      <text x="290" y="52" className={styles.label}>y</text>
      <text x="358" y="200" className={styles.label}>x</text>

      {/* Интеграл сдвинут вправо: нижний левый угол группы пустой,
          чтобы на узком окне рисунок не заходил под поле ввода */}
      <path d="M 184 222 C 176 214 166 220 166 236 L 162 300 C 162 314 152 320 144 312" />
      <path d={infinity(190, 216, 0.6)} />
      <path d={`M 134 326 L 143 326 ${infinity(157, 326, 0.6)}`} />
      <text x="194" y="284">f(x) dx</text>

      {/* Дуга идёт между формулой и бензольным кольцом, не задевая их */}
      <path d="M 210 336 C 280 328 336 294 374 240" />

      {/* Бензольное кольцо: правильный шестиугольник, три двойные связи параллельно
          сторонам через одну и заместитель по направлению от центра */}
      <g transform="translate(330 340)">
        <path d="M 0 -28 L 24.2 -14 L 24.2 14 L 0 28 L -24.2 14 L -24.2 -14 Z" />
        <path d="M 2.4 -18.7 L 15 -11.5 M 15 11.5 L 2.4 18.7 M -17.5 7.3 L -17.5 -7.3" />
        <path d="M -24.2 14 L -43.3 25" />
        <Node x={-43.3} y={25} r={5} />
      </g>

      <circle cx="14" cy="22" r="5" className={styles.solid} />
      <circle cx="364" cy="26" r="4" className={styles.solid} />
      <circle cx="130" cy="378" r="4" className={styles.solid} />
    </svg>
  )
}

export function Doodles() {
  return (
    <>
      <LeftDoodles />
      <RightDoodles />
    </>
  )
}
