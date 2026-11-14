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
    <svg className={`${styles.cluster} ${styles.left}`} viewBox="0 0 220 420" aria-hidden="true">
      {/* Молекула: кольцо из шести атомов и боковые цепочки */}
      <path d="M 44 62 L 76 46 L 106 64 L 104 98 L 72 114 L 42 96 Z" />
      <path d="M 76 46 L 80 16 M 106 64 L 138 56 M 104 98 L 126 124 M 42 96 L 16 112 M 44 62 L 18 48" />
      <Node x={44} y={62} r={6} />
      <Node x={76} y={46} r={6} />
      <Node x={106} y={64} r={6} />
      <Node x={104} y={98} r={6} />
      <Node x={72} y={114} r={6} />
      <Node x={42} y={96} r={6} />
      <Node x={80} y={16} r={4.5} />
      <Node x={138} y={56} r={5} />
      <Node x={126} y={124} r={4.5} />
      <Node x={16} y={112} r={4.5} />
      <Node x={18} y={48} r={5} />

      <text x="38" y="196" transform="rotate(-7 38 196)">2 + 2 = 4</text>

      {/* Атом: три орбиты и ядро */}
      <g transform="translate(150 284)">
        <ellipse rx="44" ry="16" />
        <ellipse rx="44" ry="16" transform="rotate(60)" />
        <ellipse rx="44" ry="16" transform="rotate(-60)" />
        <circle r="6" className={styles.solid} />
      </g>

      <path d="M 10 262 C 18 318 50 352 104 364" />
      <circle cx="30" cy="398" r="4" className={styles.solid} />
      <circle cx="196" cy="150" r="3" className={styles.solid} />
      <circle cx="176" cy="22" r="3.5" className={styles.solid} />
    </svg>
  )
}

function RightDoodles() {
  return (
    <svg className={`${styles.cluster} ${styles.right}`} viewBox="0 0 220 420" aria-hidden="true">
      <text x="14" y="58" transform="rotate(-6 14 58)">
        E = mc
        <tspan dy="-14" className={styles.sup}>2</tspan>
      </text>

      {/* График: оси со стрелками и парабола ветвями вниз */}
      <path d="M 120 236 L 116 96 M 106 110 L 116 94 L 128 108" />
      <path d="M 70 208 L 206 186 M 190 176 L 208 186 L 192 198" />
      <path d="M 134 182 C 142 124 170 120 184 176" />
      <text x="132" y="104" className={styles.label}>y</text>
      <text x="196" y="220" className={styles.label}>x</text>

      {/* Интеграл от минус до плюс бесконечности */}
      <path d="M 58 276 C 50 268 40 274 40 290 L 36 358 C 36 372 26 378 18 370" />
      <path d={infinity(64, 268, 0.55)} />
      <path d={`M 10 382 L 18 382 ${infinity(31, 382, 0.55)}`} />
      <text x="66" y="338">f(x) dx</text>

      <circle cx="200" cy="20" r="4" className={styles.solid} />
      <circle cx="30" cy="150" r="3" className={styles.solid} />
      <circle cx="196" cy="300" r="3.5" className={styles.solid} />
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
