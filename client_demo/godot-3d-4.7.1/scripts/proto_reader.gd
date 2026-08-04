class_name TzProtoReader
extends RefCounted

## 带边界检查的Proto读取器；Godot收到的每个WebSocket包都是一个完整消息。
## Bounds-checked protobuf reader; each Godot WebSocket packet is one complete message.

var data: PackedByteArray
var offset: int = 0

func _init(bytes: PackedByteArray = PackedByteArray()) -> void:
	data = bytes

func eof() -> bool:
	return offset >= data.size()

func tag() -> Dictionary:
	var value := varint()
	return {"field": value >> 3, "wire": value & 7}

func varint() -> int:
	var value: int = 0
	var shift: int = 0
	while offset < data.size() and shift <= 63:
		var current := int(data[offset])
		offset += 1
		value |= (current & 0x7f) << shift
		if (current & 0x80) == 0:
			return value
		shift += 7
	return value

func sint32() -> int:
	var value := varint()
	return (value >> 1) ^ -(value & 1)

func uint32() -> int:
	return varint() & 0xffffffff

func int32() -> int:
	var value := varint()
	if value & 0x80000000:
		return value - 0x100000000
	return value

func uint64() -> int:
	return varint()

func int64() -> int:
	return varint()

func boolean() -> bool:
	return varint() != 0

func string_value() -> String:
	return bytes_value().get_string_from_utf8()

func bytes_value() -> PackedByteArray:
	var length := varint()
	var start := offset
	offset = mini(offset + length, data.size())
	return data.slice(start, offset)

func float32() -> float:
	if offset + 4 > data.size():
		offset = data.size()
		return 0.0
	var buffer := StreamPeerBuffer.new()
	buffer.big_endian = false
	buffer.data_array = data.slice(offset, offset + 4)
	offset += 4
	return buffer.get_float()

func float64() -> float:
	if offset + 8 > data.size():
		offset = data.size()
		return 0.0
	var buffer := StreamPeerBuffer.new()
	buffer.big_endian = false
	buffer.data_array = data.slice(offset, offset + 8)
	offset += 8
	return buffer.get_double()

func skip(wire: int) -> void:
	match wire:
		0:
			varint()
		1:
			offset = mini(offset + 8, data.size())
		2:
			var length := varint()
			offset = mini(offset + length, data.size())
		5:
			offset = mini(offset + 4, data.size())
		_:
			offset = data.size()
