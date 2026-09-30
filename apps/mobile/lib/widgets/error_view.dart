import 'package:flutter/material.dart';

import '../api/api_error.dart';
import '../theme/theme.dart';

/// Hatanın kullanıcıya gösterilebilir metni; ham exception metni asla gösterilmez.
String displayMessage(Object error) => error is ApiError
    ? error.message
    : 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.';

/// Hata kartı: güvenli mesaj + destek için istek referansı + isteğe bağlı tekrar dene.
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.error, this.title, this.onRetry});

  final Object error;
  final String? title;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final requestId = error is ApiError ? (error as ApiError).requestId : null;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: EmekColors.dangerTint.withValues(alpha: 0.35),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: EmekColors.dangerTint),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              title ?? 'Bir sorun oluştu',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(displayMessage(error)),
            if (requestId != null) ...[
              const SizedBox(height: 4),
              Text(
                'Referans: $requestId',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: onRetry,
                child: const Text('Tekrar dene'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
