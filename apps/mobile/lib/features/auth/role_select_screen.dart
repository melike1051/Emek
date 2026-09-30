import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../session/providers.dart';
import '../../session/session.dart';
import '../../theme/theme.dart';
import '../../widgets/error_view.dart';

enum _Role { customer, provider }

/// İlk girişte profil oluşturma (web `/rol-sec`). Sağlayıcı profili taslak olarak açılır;
/// yayına alma başvuru + operatör onayıyladır.
class RoleSelectScreen extends ConsumerStatefulWidget {
  const RoleSelectScreen({super.key});

  @override
  ConsumerState<RoleSelectScreen> createState() => _RoleSelectScreenState();
}

class _RoleSelectScreenState extends ConsumerState<RoleSelectScreen> {
  final _name = TextEditingController();
  final _bio = TextEditingController();
  final _experience = TextEditingController();
  _Role? _role;
  String? _nameError;
  String? _experienceError;
  Object? _serverError;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _bio.dispose();
    _experience.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    final experienceText = _experience.text.trim().replaceAll(',', '.');
    final experience = experienceText.isEmpty
        ? null
        : double.tryParse(experienceText);
    setState(() {
      _nameError = name.length < 2 || name.length > 120
          ? 'Ad 2–120 karakter olmalı.'
          : null;
      _experienceError =
          experienceText.isNotEmpty &&
              (experience == null || experience < 0 || experience > 80)
          ? 'Deneyim 0–80 yıl arasında olmalı.'
          : null;
      _serverError = null;
    });
    if (_nameError != null || _experienceError != null) return;

    setState(() => _busy = true);
    final api = SessionApi(ref.read(apiClientProvider));
    try {
      if (_role == _Role.provider) {
        await api.createProvider(
          name,
          bio: _bio.text.trim(),
          experienceYears: experience,
        );
      } else {
        await api.createCustomer(name);
      }
      // `/rol-sec` ikinci profil eklemek için de kullanılır; router burada kalmaya izin verir.
      // Bu yüzden yeni oturumun ana sayfasına ekran kendisi gider (web RoleSelect ile aynı).
      final session = await ref.refresh(sessionProvider.future);
      if (mounted && session != null) context.go(session.home);
    } catch (error) {
      setState(() => _serverError = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              "Emek'te nasıl yer almak istersiniz?",
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 24),
            _RoleCard(
              title: 'Hizmet almak istiyorum',
              subtitle: 'Hane & günlük destek',
              selected: _role == _Role.customer,
              onTap: () => setState(() => _role = _Role.customer),
            ),
            const SizedBox(height: 12),
            _RoleCard(
              title: 'Emeğimi sunmak istiyorum',
              subtitle: 'Hizmet sağlayıcı',
              selected: _role == _Role.provider,
              onTap: () => setState(() => _role = _Role.provider),
            ),
            if (_role != null) ...[
              const SizedBox(height: 24),
              TextField(
                key: const Key('role.name'),
                controller: _name,
                maxLength: 120,
                decoration: InputDecoration(
                  labelText: _role == _Role.provider
                      ? 'Görünen adınız'
                      : 'Adınız',
                  helperText: 'Karşı tarafa bu ad gösterilir (ör. Hatice Y.).',
                  errorText: _nameError,
                ),
              ),
              if (_role == _Role.provider) ...[
                const SizedBox(height: 12),
                TextField(
                  controller: _bio,
                  maxLength: 2000,
                  maxLines: 4,
                  decoration: const InputDecoration(
                    labelText: 'Kendinizi tanıtın (isteğe bağlı)',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _experience,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: InputDecoration(
                    labelText: 'Deneyim (yıl, isteğe bağlı)',
                    errorText: _experienceError,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Sağlayıcı profiliniz önce taslak olarak oluşturulur; hizmet, bölge ve '
                  'müsaitlik bilgilerinizi ekleyip incelemeye gönderdiğinizde yayına alınır.',
                ),
              ],
            ],
            if (_serverError != null) ...[
              const SizedBox(height: 16),
              ErrorView(error: _serverError!),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _role == null || _busy ? null : _submit,
              child: Text(_busy ? 'Kaydediliyor…' : 'Devam et'),
            ),
          ],
        ),
      ),
    );
  }
}

class _RoleCard extends StatelessWidget {
  const _RoleCard({
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: selected,
      button: true,
      child: Card(
        color: selected ? EmekColors.secondaryTint : null,
        child: ListTile(
          onTap: onTap,
          title: Text(title),
          subtitle: Text(subtitle),
          trailing: Icon(
            selected ? Icons.check_circle : Icons.circle_outlined,
            color: selected ? EmekColors.secondary : EmekColors.border,
          ),
        ),
      ),
    );
  }
}
