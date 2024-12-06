(module
  (memory (export "memory") 128) ;; Fixed memory size (128 pages = ~8.3 MB)

  ;; Decoding function
  (func (export "decode")
    (param $buffer i32)    ;; Pointer to the buffer
    (param $length i32)    ;; Number of bytes to process
    (local $i i32)         ;; Loop counter

    ;; Prepare SIMD constants
    (local $sub_const v128)
    (local $data v128)

    ;; Initialize SIMD constants
    (local.set $sub_const (v128.const i8x16 32 32 32 32 32 32 32 32 32 32 32 32 32 32 32 32))

    (loop $simd_loop ;; Label for looping
      ;; Break if $i >= $length
      (br_if 1
        (i32.ge_u (local.get $i) (local.get $length))
      )

      ;; Load 16 bytes from the buffer
      (local.set $data
        (v128.load (i32.add (local.get $buffer) (local.get $i)))
      )

      ;; Subtract 32 from each byte
      (local.set $data
        (i8x16.sub (local.get $data) (local.get $sub_const))
      )

      ;; Shift each byte left by 2
      (local.set $data
        (i8x16.shl (local.get $data) (i32.const 2)) ;; Use scalar for shift
      )

      ;; Store the transformed 16 bytes back into the buffer
      (v128.store (i32.add (local.get $buffer) (local.get $i)) (local.get $data))

      ;; Increment loop counter by 16 (processed bytes)
      (local.set $i
        (i32.add (local.get $i) (i32.const 16))
      )

      ;; Continue loop
      (br $simd_loop)
    )
  )
)
