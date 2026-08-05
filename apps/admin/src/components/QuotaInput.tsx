/**
 * Ввод квоты: число отдельно, единица отдельно.
 *
 * Единица выбирается списком, а не угадывается из набранного текста, —
 * поэтому «500» больше не может означать 500 байт.
 */
import { QUOTA_UNITS, type QuotaUnit } from '../lib/quota';

export function QuotaInput({
  amount,
  unit,
  onAmount,
  onUnit,
}: {
  amount: string;
  unit: QuotaUnit;
  onAmount: (value: string) => void;
  onUnit: (value: QuotaUnit) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        className="mt-input"
        inputMode="decimal"
        aria-label="Квота, число"
        style={{ flex: '1 1 auto', minWidth: 0 }}
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
      />
      <select
        className="mt-select"
        aria-label="Единица квоты"
        style={{ flex: '0 0 auto', width: 90 }}
        value={unit}
        onChange={(e) => onUnit(e.target.value as QuotaUnit)}
      >
        {QUOTA_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </div>
  );
}
