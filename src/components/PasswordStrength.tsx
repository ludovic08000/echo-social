import { useMemo } from 'react';

interface PasswordStrengthProps {
  password: string;
}

function getStrength(password: string): { score: number; label: string; color: string } {
  if (!password) return { score: 0, label: '', color: '' };

  let score = 0;
  if (password.length >= 10) score++;
  if (password.length >= 14) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { score: 1, label: 'Faible', color: 'bg-destructive' };
  if (score === 2) return { score: 2, label: 'Moyen', color: 'bg-orange-500' };
  if (score === 3) return { score: 3, label: 'Bon', color: 'bg-yellow-500' };
  if (score >= 4) return { score: 4, label: 'Fort', color: 'bg-green-500' };

  return { score: 0, label: '', color: '' };
}

export default function PasswordStrength({ password }: PasswordStrengthProps) {
  const { score, label, color } = useMemo(() => getStrength(password), [password]);

  if (!password) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((level) => (
          <div
            key={level}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              level <= score ? color : 'bg-muted'
            }`}
          />
        ))}
      </div>
      <p className={`text-xs ${score <= 1 ? 'text-destructive' : score === 2 ? 'text-orange-500' : score === 3 ? 'text-yellow-500' : 'text-green-500'}`}>
        Force : {label}
        {score <= 2 && (
          <span className="text-muted-foreground ml-1">
            — Ajoutez des majuscules, chiffres ou caractères spéciaux
          </span>
        )}
      </p>
    </div>
  );
}
