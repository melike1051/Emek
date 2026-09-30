import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/customer_api.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import 'customer_providers.dart';

/// Yeni hizmet adresi (Kaynak: CreateAddressDto — city/district 2..100, line 5..500,
/// label ≤60). Koordinat cihaz konumundan ("Konumumu kullan") ya da elle; adres → koordinat
/// çözümleme yok (R-101).
class AddressForm extends ConsumerStatefulWidget {
  const AddressForm({super.key, required this.onCreated, this.onCancel});
  final ValueChanged<Address> onCreated;
  final VoidCallback? onCancel;

  @override
  ConsumerState<AddressForm> createState() => _AddressFormState();
}

class _AddressFormState extends ConsumerState<AddressForm> {
  final _label = TextEditingController();
  final _city = TextEditingController();
  final _district = TextEditingController();
  final _line = TextEditingController();
  final _latitude = TextEditingController();
  final _longitude = TextEditingController();
  final _errors = <String, String>{};
  Object? _serverError;
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_label, _city, _district, _line, _latitude, _longitude]) {
      c.dispose();
    }
    super.dispose();
  }

  double? _coordinate(TextEditingController c, double limit) {
    final value = double.tryParse(c.text.trim().replaceAll(',', '.'));
    return value == null || value.abs() > limit ? null : value;
  }

  Future<void> _submit() async {
    final latitude = _coordinate(_latitude, 90);
    final longitude = _coordinate(_longitude, 180);
    String? length(TextEditingController c, int min, int max) {
      final n = c.text.trim().length;
      return n < min || n > max ? '$min–$max karakter olmalı.' : null;
    }

    setState(() {
      _errors
        ..clear()
        ..addAll({
          'city': ?length(_city, 2, 100),
          'district': ?length(_district, 2, 100),
          'line': ?length(_line, 5, 500),
          if (_label.text.trim().length > 60) 'label': 'En fazla 60 karakter.',
          if (latitude == null) 'latitude': 'Geçerli bir enlem girin.',
          if (longitude == null) 'longitude': 'Geçerli bir boylam girin.',
        });
      _serverError = null;
    });
    if (_errors.isNotEmpty) return;

    setState(() => _busy = true);
    try {
      final address = await ref
          .read(customerApiProvider)
          .createAddress(
            label: _label.text.trim(),
            city: _city.text.trim(),
            district: _district.text.trim(),
            line: _line.text.trim(),
            latitude: latitude!,
            longitude: longitude!,
          );
      widget.onCreated(address);
    } catch (error) {
      if (mounted) setState(() => _serverError = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _field(
    String key,
    String label,
    TextEditingController c, {
    TextInputType? type,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextField(
      key: Key('address.$key'),
      controller: c,
      keyboardType: type,
      decoration: InputDecoration(labelText: label, errorText: _errors[key]),
    ),
  );

  @override
  Widget build(BuildContext context) {
    const decimal = TextInputType.numberWithOptions(
      decimal: true,
      signed: true,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 8),
        _field('label', 'Etiket (isteğe bağlı)', _label),
        _field('city', 'İl', _city),
        _field('district', 'İlçe', _district),
        _field('line', 'Açık adres', _line),
        UseMyLocationButton(
          onLocated: (lat, lon) => setState(() {
            _latitude.text = lat.toStringAsFixed(6);
            _longitude.text = lon.toStringAsFixed(6);
          }),
        ),
        Row(
          children: [
            Expanded(
              child: _field('latitude', 'Enlem', _latitude, type: decimal),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _field('longitude', 'Boylam', _longitude, type: decimal),
            ),
          ],
        ),
        if (_serverError != null) ...[
          ErrorView(error: _serverError!),
          const SizedBox(height: 12),
        ],
        BusyButton(label: 'Adresi kaydet', busy: _busy, onPressed: _submit),
        if (widget.onCancel != null)
          TextButton(onPressed: widget.onCancel, child: const Text('Vazgeç')),
      ],
    );
  }
}
