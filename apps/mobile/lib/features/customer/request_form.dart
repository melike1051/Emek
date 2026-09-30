import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/customer_api.dart';
import '../../domain/booking_rules.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import 'customer_providers.dart';

/// Form yolu (web `RequestForm`): hizmet + İstanbul saatiyle gün/aralık + süre → yeni talep.
/// "Düzelt" akışında [initial] ile mevcut talebin değerleri gelir; mevcut talep değişmez
/// (PATCH ucu yok), yeni talep oluşur.
class RequestForm extends ConsumerStatefulWidget {
  const RequestForm({
    super.key,
    required this.addressId,
    required this.onCreated,
    this.initial,
  });
  final String addressId;
  final BookingRequest? initial;
  final void Function(BookingRequest request) onCreated;

  @override
  ConsumerState<RequestForm> createState() => _RequestFormState();
}

typedef _Time = ({int hour, int minute});

class _RequestFormState extends ConsumerState<RequestForm> {
  String? _serviceId;
  DateTime? _date;
  _Time? _from = (hour: 9, minute: 0);
  _Time? _to = (hour: 17, minute: 0);
  final _duration = TextEditingController(text: '180');
  String? _localError;
  Object? _serverError;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final initial = widget.initial;
    if (initial != null) {
      final start = toIstanbul(initial.preferredStart);
      final end = toIstanbul(initial.preferredEnd);
      _serviceId = initial.serviceId;
      _date = DateTime(start.year, start.month, start.day);
      _from = (hour: start.hour, minute: start.minute);
      _to = (hour: end.hour, minute: end.minute);
      _duration.text = '${initial.durationMinutes}';
    }
  }

  @override
  void dispose() {
    _duration.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final today = toIstanbul(DateTime.now());
    final picked = await showDatePicker(
      context: context,
      firstDate: DateTime(today.year, today.month, today.day),
      lastDate: DateTime(
        today.year,
        today.month,
        today.day,
      ).add(const Duration(days: 90)),
      initialDate: _date ?? DateTime(today.year, today.month, today.day + 1),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _pickTime(bool from) async {
    final current = from ? _from : _to;
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(
        hour: current?.hour ?? 9,
        minute: current?.minute ?? 0,
      ),
    );
    if (picked == null) return;
    setState(() {
      final value = (hour: picked.hour, minute: picked.minute);
      if (from) {
        _from = value;
      } else {
        _to = value;
      }
    });
  }

  Future<void> _submit() async {
    if (_serviceId == null) {
      setState(() => _localError = 'Hizmet seçin.');
      return;
    }
    final window = buildWindow(
      date: _date,
      from: _from,
      to: _to,
      durationMinutes: int.tryParse(_duration.text.trim()) ?? 0,
    );
    switch (window) {
      case WindowError(:final message):
        setState(() => _localError = message);
        return;
      case WindowOk(:final start, :final end):
        setState(() {
          _localError = null;
          _serverError = null;
          _busy = true;
        });
        try {
          final created = await ref
              .read(customerApiProvider)
              .requestFromForm(
                serviceId: _serviceId!,
                addressId: widget.addressId,
                preferredStart: start,
                preferredEnd: end,
                durationMinutes: int.parse(_duration.text.trim()),
              );
          widget.onCreated(created);
        } catch (error) {
          if (mounted) setState(() => _serverError = error);
        } finally {
          if (mounted) setState(() => _busy = false);
        }
    }
  }

  String _fmt(_Time? time) => time == null
      ? 'Seçin'
      : '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final services = ref.watch(servicesProvider);
    return AsyncBody(
      value: services,
      onRetry: () => ref.invalidate(servicesProvider),
      data: (list) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DropdownButtonFormField<String>(
            key: const Key('request.service'),
            initialValue: _serviceId,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Hizmet'),
            items: [
              for (final service in list)
                DropdownMenuItem(value: service.id, child: Text(service.name)),
            ],
            onChanged: (id) => setState(() {
              _serviceId = id;
              final picked = list.firstWhere((s) => s.id == id);
              if (picked.defaultDurationMinutes != null) {
                _duration.text = '${picked.defaultDurationMinutes}';
              }
            }),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const Key('request.date'),
            onPressed: _pickDate,
            icon: const Icon(Icons.calendar_today_outlined),
            label: Text(
              _date == null ? 'Tarih seçin' : formatCalendarDay(_date!),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => _pickTime(true),
                  child: Text('En erken ${_fmt(_from)}'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: () => _pickTime(false),
                  child: Text('En geç ${_fmt(_to)}'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text('Saatler İstanbul saatidir.'),
          const SizedBox(height: 12),
          TextField(
            key: const Key('request.duration'),
            controller: _duration,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Süre (dakika)'),
          ),
          if (_localError != null) ...[
            const SizedBox(height: 12),
            Notice(_localError!, danger: true),
          ],
          if (_serverError != null) ...[
            const SizedBox(height: 12),
            ErrorView(error: _serverError!),
          ],
          const SizedBox(height: 16),
          BusyButton(label: 'Talebi oluştur', busy: _busy, onPressed: _submit),
        ],
      ),
    );
  }
}
