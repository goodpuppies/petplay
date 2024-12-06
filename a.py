import numpy as np

image = np.random.randint(0, 256, (2048, 2048), dtype=np.uint8)
memory_view = memoryview(image)

print("Memoryview size:", memory_view.nbytes)  # Expect 1555200
print("Tobytes length:", len(memory_view.tobytes()))  # Should also be 1555200
