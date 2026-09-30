import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/customer_api.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import 'address_form.dart';
import 'customer_providers.dart';
import 'request_form.dart';

/// Web: `ExploreHome` karşılığı. `MAX_RAW_TEXT_LENGTH` backend ile aynı.
const maxRawTextLength = 2000;

/// Keşfet & talep: adres → doğal dil talebi (netleştirme soruları) ya da form.
/// AI erişilemezse (`FORM_REQUIRED`) form kendiliğinden açılır (T-15).
class ExploreScreen extends ConsumerStatefulWidget {
  const ExploreScreen({super.key});

  @override
  ConsumerState<ExploreScreen> createState() => _ExploreScreenState();
}

class _ExploreScreenState extends ConsumerState<ExploreScreen> {
  final _text = TextEditingController();
  String? _addressId;
  bool _formMode = false;
  bool _degraded = false;
  List<Clarification> _clarifications = const [];
  Object? _error;
  bool _busy = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _open(BookingRequest request) => context.push('/talep/${request.id}');

  Future<void> _submitText() async {
    final text = _text.text.trim();
    final addressId = _effectiveAddress(ref.read(addressesProvider));
    if (addressId == null || text.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await ref
          .read(customerApiProvider)
          .requestFromText(text, addressId);
      if (!mounted) return;
      switch (result.status) {
        case FromTextStatus.created:
          setState(() => _clarifications = const []);
          _open(result.request!);
        case FromTextStatus.needsClarification:
          setState(() => _clarifications = result.clarifications);
        case FromTextStatus.formRequired:
          setState(() {
            _formMode = true;
            _degraded = true;
          });
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _appendOption(String option) {
    _text.text = '${_text.text.trimRight()} $option';
    _text.selection = TextSelection.collapsed(offset: _text.text.length);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final addresses = ref.watch(addressesProvider);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          'Eviniz ve sevdikleriniz için güvenilir eller.',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 16),
        SectionCard(
          title: 'Adres',
          children: [
            AsyncBody(
              value: addresses,
              onRetry: () => ref.invalidate(addressesProvider),
              data: (list) => _AddressPicker(
                addresses: list,
                value: _effectiveAddress(addresses),
                onChanged: (id) => setState(() => _addressId = id),
                onCreated: (address) {
                  ref.invalidate(addressesProvider);
                  setState(() => _addressId = address.id);
                },
              ),
            ),
          ],
        ),
        if (!_formMode)
          SectionCard(
            title: 'Neye ihtiyacınız var?',
            children: [
              TextField(
                key: const Key('explore.text'),
                controller: _text,
                maxLength: maxRawTextLength,
                maxLines: 4,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  hintText:
                      'Örn. “Cumartesi öğleden sonra 3 saatlik ev temizliği, 2+1 daire.”',
                ),
              ),
              if (_clarifications.isNotEmpty) ...[
                const Notice(
                  'Birkaç ayrıntıyı netleştirelim. Metninize ekleyip tekrar gönderin:',
                ),
                for (final item in _clarifications) ...[
                  Text(item.question),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final option in item.options)
                        ActionChip(
                          label: Text(option),
                          onPressed: () => _appendOption(option),
                        ),
                    ],
                  ),
                  const SizedBox(height: 8),
                ],
              ],
              if (_error != null) ...[
                ErrorView(error: _error!),
                const SizedBox(height: 12),
              ],
              BusyButton(
                label: 'Uygun sağlayıcıyı bul',
                busy: _busy,
                onPressed:
                    _effectiveAddress(addresses) == null ||
                        _text.text.trim().isEmpty
                    ? null
                    : _submitText,
              ),
              TextButton(
                onPressed: () => setState(() => _formMode = true),
                child: const Text('Formla oluştur'),
              ),
            ],
          )
        else
          SectionCard(
            title: 'Talep formu',
            children: [
              if (_degraded)
                const Notice(
                  'Akıllı talep şu an kullanılamıyor; talebinizi formla oluşturabilirsiniz.',
                ),
              if (_effectiveAddress(addresses) == null)
                const Notice('Önce bir hizmet adresi ekleyin.')
              else
                RequestForm(
                  addressId: _effectiveAddress(addresses)!,
                  onCreated: _open,
                ),
              TextButton(
                onPressed: () => setState(() {
                  _formMode = false;
                  _degraded = false;
                }),
                child: const Text('Kendi cümlelerimle anlatayım'),
              ),
            ],
          ),
      ],
    );
  }

  /// Seçili adres; seçim yapılmadıysa listedeki ilk adres (web ile aynı varsayılan).
  String? _effectiveAddress(AsyncValue<List<Address>> addresses) {
    if (_addressId != null) return _addressId;
    final list = addresses.value;
    return list == null || list.isEmpty ? null : list.first.id;
  }
}

class _AddressPicker extends StatefulWidget {
  const _AddressPicker({
    required this.addresses,
    required this.value,
    required this.onChanged,
    required this.onCreated,
  });
  final List<Address> addresses;
  final String? value;
  final ValueChanged<String> onChanged;
  final ValueChanged<Address> onCreated;

  @override
  State<_AddressPicker> createState() => _AddressPickerState();
}

class _AddressPickerState extends State<_AddressPicker> {
  bool _adding = false;

  @override
  Widget build(BuildContext context) {
    final showForm = _adding || widget.addresses.isEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.addresses.isNotEmpty)
          DropdownButtonFormField<String>(
            key: const Key('explore.address'),
            initialValue: widget.value,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Hizmet adresi'),
            items: [
              for (final address in widget.addresses)
                DropdownMenuItem(
                  value: address.id,
                  child: Text(address.display, overflow: TextOverflow.ellipsis),
                ),
            ],
            onChanged: (id) {
              if (id != null) widget.onChanged(id);
            },
          ),
        if (showForm)
          AddressForm(
            onCreated: (address) {
              setState(() => _adding = false);
              widget.onCreated(address);
            },
            onCancel: widget.addresses.isEmpty
                ? null
                : () => setState(() => _adding = false),
          )
        else
          TextButton(
            onPressed: () => setState(() => _adding = true),
            child: const Text('Yeni adres ekle'),
          ),
      ],
    );
  }
}
