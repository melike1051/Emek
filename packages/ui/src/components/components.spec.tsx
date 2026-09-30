import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { Avatar, initialsOf } from './Avatar';
import { Button } from './Button';
import { ErrorState, Skeleton } from './States';
import { TextField } from './TextField';

describe('Button', () => {
  it('yüklenirken kilitlenir ve tıklama iletmez (çift gönderim yok)', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Gönder
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Gönder' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('varsayılan type="button" — form içinde istemsiz submit yok', () => {
    render(<Button>Tamam</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});

describe('Avatar', () => {
  it.each([
    ['Hatice Yılmaz', 'HY'],
    ['meryem ergün', 'ME'],
    ['ilknur', 'İ'],
    ['  Ayşe   Nur  Işık ', 'AI'],
    ['', ''],
  ])('%s → %s', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  it('erişilebilir ad ve doğrulama bilgisini taşır', () => {
    render(<Avatar name="Hatice Yılmaz" verified />);
    expect(screen.getByRole('img', { name: 'Hatice Yılmaz' })).toBeInTheDocument();
    expect(screen.getByText('Kimliği doğrulandı', { selector: 'span' })).toBeInTheDocument();
  });
});

describe('TextField', () => {
  it('etiketi alana bağlar', () => {
    render(<TextField label="Telefon" />);
    expect(screen.getByLabelText('Telefon')).toBeInTheDocument();
  });

  it('hata mesajını aria-describedby ile bağlar ve alanı geçersiz işaretler', () => {
    render(<TextField label="Telefon" hint="+90 ile" error="Geçersiz numara" />);
    const input = screen.getByLabelText('Telefon');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Geçersiz numara');
    expect(screen.queryByText('+90 ile')).not.toBeInTheDocument();
  });
});

describe('ErrorState / Skeleton', () => {
  it('güvenli mesajı, referansı ve tekrar deneme aksiyonunu gösterir', () => {
    const onRetry = vi.fn();
    render(
      <ErrorState message="Seçilen zaman artık uygun değil." requestId="req-1" onRetry={onRetry} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Seçilen zaman artık uygun değil.');
    expect(screen.getByText('Referans: req-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('yükleme durumunu ekran okuyucuya bildirir', () => {
    render(<Skeleton label="Randevular yükleniyor" />);
    expect(screen.getByRole('status')).toHaveTextContent('Randevular yükleniyor');
  });
});
