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

function LeftDoodles() {
  return (
    <svg className={`${styles.cluster} ${styles.left}`} viewBox="0 0 300 250" aria-hidden="true">
      {/* Молекула: кольцо из шести атомов и боковые цепочки */}
      <path d="M 46 66 L 80 48 L 112 68 L 110 104 L 76 122 L 44 102 Z" />
      <path d="M 80 48 L 84 16 M 112 68 L 146 60 M 110 104 L 132 132 M 44 102 L 18 120 M 46 66 L 18 52" />
      <Node x={46} y={66} r={6} />
      <Node x={80} y={48} r={6} />
      <Node x={112} y={68} r={6} />
      <Node x={110} y={104} r={6} />
      <Node x={76} y={122} r={6} />
      <Node x={44} y={102} r={6} />
      <Node x={84} y={16} r={4.5} />
      <Node x={146} y={60} r={5} />
      <Node x={132} y={132} r={4.5} />
      <Node x={18} y={120} r={4.5} />
      <Node x={18} y={52} r={5} />

      <text x="186" y="58" transform="rotate(-8 186 58)">2 + 2 = 4</text>

      {/* Атом: три орбиты и ядро */}
      <g transform="translate(228 150)">
        <ellipse rx="42" ry="15" />
        <ellipse rx="42" ry="15" transform="rotate(60)" />
        <ellipse rx="42" ry="15" transform="rotate(-60)" />
        <circle r="6" className={styles.solid} />
      </g>

      <path d="M 4 160 C 22 196 70 214 134 210" />
      <circle cx="26" cy="236" r="4.5" className={styles.solid} />
      <circle cx="160" cy="232" r="3.5" className={styles.solid} />
    </svg>
  )
}

function RightDoodles() {
  return (
    <svg className={`${styles.cluster} ${styles.right}`} viewBox="0 0 360 370" aria-hidden="true">
      <text x="24" y="80" transform="rotate(-7 24 80)">
        E = mc
        <tspan dy="-16" className={styles.sup}>2</tspan>
      </text>

      {/* График: оси со стрелками и парабола ветвями вниз */}
      <path d="M 252 196 L 240 46 M 230 62 L 240 44 L 254 58" />
      <path d="M 196 172 L 338 146 M 322 136 L 340 146 L 324 158" />
      <path d="M 266 140 C 274 82 302 78 316 134" />
      <text x="256" y="54" className={styles.label}>y</text>
      <text x="334" y="180" className={styles.label}>x</text>

      <path d="M 14 154 C 54 140 96 124 140 108" />

      {/* Интеграл сдвинут вправо: нижний левый угол группы пустой,
          чтобы на узком окне рисунок не заходил под поле ввода */}
      <path d="M 182 196 C 174 188 164 194 164 210 L 160 270 C 160 284 150 290 142 282" />
      <path d={infinity(188, 190, 0.55)} />
      <path d={`M 134 294 L 142 294 ${infinity(155, 294, 0.55)}`} />
      <text x="190" y="256">f(x) dx</text>

      <path d="M 196 356 C 250 344 312 300 352 250" />

      {/* Бензольное кольцо с ответвлением */}
      <g transform="translate(318 318)">
        <path d="M 0 -26 L 22 -13 L 22 13 L 0 26 L -22 13 L -22 -13 Z" />
        <path d="M 4 -16 L 14 -10 M 15 -5 L 15 6 M -14 10 L -4 16" />
        <path d="M -22 -13 L -42 -24" />
        <Node x={-46} y={-26} r={5} />
      </g>

      <circle cx="10" cy="20" r="4.5" className={styles.solid} />
      <circle cx="346" cy="24" r="3.5" className={styles.solid} />
      <circle cx="150" cy="340" r="3.5" className={styles.solid} />
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
